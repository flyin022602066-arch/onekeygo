import importlib.util
import math
import pathlib
import sys
import tempfile
import types
import unittest
from fractions import Fraction
from unittest.mock import patch

import torch


module_path = pathlib.Path(__file__).resolve().parents[1] / "comfyui-nodes" / "mijing_h3_safe" / "__init__.py"
spec = importlib.util.spec_from_file_location("mijing_h3_safe_test", module_path)
safe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safe)


class Nested:
    is_nested = True

    def __init__(self, tensors):
        self.tensors = tensors


class Video:
    def __init__(self, components, bit_depth=8, color_space="bt709"):
        self.components = components
        self.bit_depth = bit_depth
        self.color_space = color_space

    def get_components(self):
        return self.components

    def get_bit_depth(self):
        return self.bit_depth

    def get_color_space(self):
        return self.color_space


class SafeH3Tests(unittest.TestCase):
    def test_tail_keeps_actual_final_frame_and_matching_audio(self):
        frames = torch.arange(209).view(209, 1, 1, 1).float()
        audio = {"waveform": torch.arange(418).view(1, 1, 418), "sample_rate": 48}
        tail, soundtrack = safe.MijingH3VideoTail().tail(frames, 124, 24, audio)
        self.assertEqual(tail.shape[0], 124)
        self.assertEqual(tail[0].item(), 85)
        self.assertEqual(tail[-1].item(), 208)
        self.assertTrue(torch.equal(soundtrack["waveform"], audio["waveform"][..., 170:418]))
        self.assertEqual(frames[0].item(), 0)

    def test_tail_resamples_non24fps_and_never_drops_the_ending(self):
        frames = torch.arange(300).view(300, 1, 1, 1).float()
        tail, soundtrack = safe.MijingH3VideoTail().tail(frames, 124, 30)
        self.assertEqual(tail.shape[0], 124)
        self.assertEqual(tail[-1].item(), 299)
        self.assertIsNone(soundtrack)
        short, _ = safe.MijingH3VideoTail().tail(frames[:30], 124, 30)
        self.assertEqual(short.shape[0], 22)
        self.assertEqual(short[-1].item(), 29)
        with self.assertRaisesRegex(ValueError, "at least 5"):
            safe.MijingH3VideoTail().tail(frames[:4], 124)

    def test_resize_changes_only_spatial_dimensions_without_mutation(self):
        video = torch.ones((1, 24, 2, 4, 8))
        result = safe.resize_video_latent(video, 6, 10)
        self.assertEqual(tuple(result.shape), (1, 24, 2, 6, 10))
        self.assertTrue(torch.equal(video, torch.ones_like(video)))
        self.assertTrue(torch.allclose(result, torch.ones_like(result)))
        self.assertEqual(safe.target_size(video, 10), (4, 10))
        self.assertEqual(safe.bounded_number(float("nan"), 1.25, 1, 1.25), 1.25)

    def test_conditioning_rebuild_keeps_reference_order_and_bridge_metadata(self):
        anchor = torch.ones((1, 24, 2, 4, 8))
        original_reference = {"kind": "image", "latent": anchor, "latent_h": 4, "latent_w": 8}
        rebuilt_reference = {"kind": "image", "latent": torch.zeros((1, 24, 1, 6, 10)), "latent_h": 6, "latent_w": 10}
        motion_audio = {"kind": "audio", "motion_context_audio_end_frame": 22, "audio_latent": torch.ones((1, 32, 2, 20))}
        metadata = {"minimax_refs": [original_reference, motion_audio], "minimax_keyframes": [{"latent": anchor, "resolved_frame_index": 0, "motion_context_index": 3}], "minimax_frame_count": 141}
        original = [["old", metadata]]
        rebuilt = [["new", {"minimax_refs": [rebuilt_reference]}]]
        result = safe.sync_conditioning(original, rebuilt, 6, 10)
        self.assertEqual(result[0][0], "new")
        self.assertIs(result[0][1]["minimax_refs"][0], rebuilt_reference)
        self.assertEqual(result[0][1]["minimax_refs"][1]["motion_context_audio_end_frame"], 22)
        self.assertEqual(result[0][1]["minimax_keyframes"][0]["motion_context_index"], 3)
        self.assertEqual(tuple(result[0][1]["minimax_keyframes"][0]["latent"].shape[-2:]), (6, 10))
        self.assertEqual(metadata["minimax_refs"][0]["latent_h"], 4)
        self.assertEqual(tuple(anchor.shape[-2:]), (4, 8))
        with self.assertRaisesRegex(ValueError, "schedule"):
            safe.sync_conditioning(original, [], 6, 10)

    def test_budget_counts_reference_video_not_just_output_resolution(self):
        video = torch.empty((1, 24, 37, 34, 60), device="meta")
        args = (video, 42, 76, 16 * 1024 ** 3, 12 * 1024 ** 3)
        self.assertEqual(safe.budget_reason(*args), "")
        heavy_reference = [[None, {"minimax_refs": [{"kind": "video", "latent": torch.empty((1, 24, 37, 48, 86), device="meta")}]}]]
        self.assertIn("token budget", safe.budget_reason(*args, heavy_reference))
        self.assertIn("GPU memory", safe.budget_reason(video, 42, 76, 16 * 1024 ** 3, 3 * 1024 ** 3))
        self.assertIn("1 MP", safe.budget_reason(video, 80, 100, math.inf, math.inf))
        self.assertIn("6-second", safe.budget_reason(torch.empty((1, 24, 62, 34, 60), device="meta"), 42, 76, math.inf, math.inf))

    def test_refinement_rebuilds_conditions_and_keeps_audio_duration(self):
        from comfy_api.latest import InputImpl, Types
        import comfy.nested_tensor
        import comfy.model_management as management
        import nodes
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo

        video = torch.ones((1, 24, 2, 4, 8))
        audio_latent = torch.ones((1, 32, 2, 8))
        audio = {"waveform": torch.ones((1, 2, 100)), "sample_rate": 48000}
        base = InputImpl.VideoFromComponents(Types.VideoComponents(images=torch.zeros((5, 64, 128, 3)), audio=audio, frame_rate=Fraction(24)))
        reference = torch.zeros((1, 96, 160, 3))
        positive = [[torch.zeros((1, 1, 2)), {"minimax_refs": [{"kind": "image", "latent": video}]}]]
        rebuilt = [[torch.ones((1, 1, 2)), {"minimax_refs": [{"kind": "image", "latent": torch.zeros((1, 24, 1, 6, 10))}]}]]
        def sampler(model, seed, steps, cfg, sampler_name, scheduler, conditioning, negative, latent, denoise):
            self.assertEqual((steps, cfg, sampler_name, scheduler, denoise), (2, 1.0, "euler", "simple", 0.2))
            self.assertEqual(tuple(latent["samples"].tensors[0].shape), (1, 24, 2, 6, 10))
            self.assertIs(conditioning[0][1]["minimax_refs"][0], rebuilt[0][1]["minimax_refs"][0])
            return (latent,)
        with patch.object(MiniMaxH3ReferenceToVideo, "execute", return_value=(rebuilt, {})) as encode, \
                patch.object(nodes, "common_ksampler", side_effect=sampler), \
                patch.object(nodes.VAEDecodeTiled, "decode", return_value=(torch.zeros((5, 96, 160, 3)),)), \
                patch.object(management, "unload_all_models"), patch.object(management, "soft_empty_cache"):
            result = safe.MijingH3SafeRefine().render(base, video, audio_latent, positive, object(), object(), object(), object(), "current shot", {"reference_image_0": reference}, 9, 6, 10, 2, 0.2, 0)
            self.assertIs(encode.call_args.kwargs["ref_images"]["ref_image_0"], reference)
            self.assertEqual(encode.call_args.kwargs["width"], 160)
            self.assertEqual(encode.call_args.kwargs["height"], 96)
            self.assertEqual(encode.call_args.kwargs["prompt"], "current shot")
            components = result.get_components()
            self.assertIs(components.audio, audio)
            self.assertEqual(components.images.shape[0], 5)
            self.assertEqual(components.frame_rate, 24)
            with self.assertRaisesRegex(ValueError, "Reference binding mismatch"):
                safe.MijingH3SafeRefine().render(base, video, audio_latent, positive, object(), object(), object(), object(), "current shot", {}, 9, 6, 10, 2, 0.2, 0)

    def test_rebuilt_budget_uses_actual_reference_shapes_before_sampling(self):
        import nodes
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo

        video = torch.zeros((1, 24, 37, 34, 60))
        audio_latent = torch.zeros((1, 32, 2, 206))
        reference = torch.empty((1, 32, 32, 3), device="meta")
        original = [[None, {"minimax_refs": [{"kind": "image", "latent": torch.empty((1, 24, 1, 2, 2), device="meta")}]}]]
        rebuilt = [[None, {"minimax_refs": [{"kind": "image", "latent": torch.empty((1, 24, 1, 400, 400), device="meta")}]}]]
        self.assertEqual(safe.budget_reason(video, 42, 76, math.inf, math.inf, original), "")
        with patch.object(MiniMaxH3ReferenceToVideo, "execute", return_value=(rebuilt, {})), \
                patch.object(nodes, "common_ksampler") as sampler:
            with self.assertRaisesRegex(ValueError, "token budget"):
                safe.MijingH3SafeRefine().render(object(), video, audio_latent, original,
                                               object(), object(), object(), object(), "current shot",
                                               {"reference_image_0": reference}, 9, 42, 76, 2, 0.2, 0)
            sampler.assert_not_called()

    def test_rebuilt_budget_does_not_scale_reference_images_twice(self):
        video = torch.empty((1, 24, 37, 34, 60), device="meta")
        rebuilt = [[None, {"minimax_refs": [{"kind": "image", "latent": torch.empty((1, 24, 1, 280, 400), device="meta")}]}]]
        self.assertEqual(safe.budget_reason(video, 42, 76, math.inf, math.inf, rebuilt, rebuilt=True), "")
        self.assertIn("token budget", safe.budget_reason(video, 42, 76, math.inf, math.inf, rebuilt))

    def test_oom_retains_base_but_user_interrupt_propagates(self):
        import comfy.model_management as management
        video = torch.ones((1, 24, 2, 8, 8))
        latent = {"samples": Nested((video, torch.zeros((1, 32, 2, 8))))}
        base = object()
        with patch.object(management, "get_torch_device", return_value=torch.device("cuda")), \
                patch.object(management, "get_free_memory", return_value=12 * 1024 ** 3), \
                patch.object(management, "unload_all_models") as unload, patch.object(management, "soft_empty_cache"), \
                patch.object(torch.cuda, "get_device_properties", return_value=types.SimpleNamespace(total_memory=16 * 1024 ** 3)), \
                patch.object(safe.MijingH3SafeRefine, "render", side_effect=torch.OutOfMemoryError("test OOM")) as render:
            result = safe.MijingH3SafeRefine().refine(base, latent, [], object(), object(), object(), object(), "shot", 9)
            self.assertIs(result["result"][0], base)
            self.assertIn("base-only", result["result"][1])
            self.assertGreaterEqual(unload.call_count, 2)
            render.side_effect = management.InterruptProcessingException()
            with self.assertRaises(management.InterruptProcessingException):
                safe.MijingH3SafeRefine().refine(base, latent, [], object(), object(), object(), object(), "shot", 9)

    def test_original_mp4_save_returns_standard_history_output(self):
        import folder_paths
        from comfy_api.latest import InputImpl, Types
        base = InputImpl.VideoFromComponents(Types.VideoComponents(images=torch.zeros((5, 32, 32, 3)), audio=None, frame_rate=Fraction(24)))
        with tempfile.TemporaryDirectory() as directory, patch.object(folder_paths, "get_output_directory", return_value=directory):
            result = safe.MijingH3PreserveVideo().preserve(base, "video/mijing-studio-test")
            saved = result["ui"]["images"][0]
            filename = pathlib.Path(directory) / saved["subfolder"] / saved["filename"]
            self.assertTrue(filename.is_file())
            self.assertGreater(filename.stat().st_size, 0)
            self.assertIs(result["result"][0], base)
            with self.assertRaisesRegex(ValueError, "prefix"):
                safe.MijingH3PreserveVideo().preserve(base, "../outside")


if __name__ == "__main__":
    sys.argv = [sys.argv[0], "--cpu"]
    import comfy.options
    comfy.options.enable_args_parsing()
    from comfy.cli_args import args
    args.cpu = True
    unittest.main(argv=[sys.argv[0]], verbosity=2)
