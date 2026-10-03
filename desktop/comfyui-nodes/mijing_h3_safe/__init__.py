import gc
import math
import os

import torch
import torch.nn.functional as functional


def bounded_number(value, default, minimum, maximum):
    try:
        parsed = float(value)
    except (ValueError, TypeError):
        parsed = default
    if not math.isfinite(parsed):
        parsed = default
    return min(maximum, max(minimum, parsed))


def target_size(video, scale):
    height, width = video.shape[-2:]
    scale = bounded_number(scale, 1.25, 1.0, 1.25)
    return tuple(max(2, round(axis * scale / 2) * 2) for axis in (height, width))


def resize_video_latent(video, height, width):
    if video.ndim != 5 or video.shape[1] != 24:
        raise ValueError("Expected H3 video latent [B,24,T,H,W]")
    batch, channels, temporal, old_height, old_width = video.shape
    source = video.detach().to(device="cpu", dtype=torch.float32)
    if (old_height, old_width) == (height, width):
        return source
    resized = torch.empty((batch, channels, temporal, height, width), dtype=torch.float32)
    for frame_index in range(temporal):
        resized[:, :, frame_index] = functional.interpolate(
            source[:, :, frame_index], size=(height, width), mode="bilinear", align_corners=False)
    return resized


def sync_conditioning(positive, rebuilt, height, width):
    if len(positive) != len(rebuilt):
        raise ValueError("Conditioning schedule changed during refinement")
    synced = []
    for (_, metadata), (embedding, rebuilt_metadata) in zip(positive, rebuilt):
        updated = dict(metadata)
        updated.pop("minimax_refs", None)
        updated.update(rebuilt_metadata)
        motion_audio = [dict(reference) for reference in metadata.get("minimax_refs", [])
                        if "motion_context_audio_end_frame" in reference]
        if motion_audio:
            updated["minimax_refs"] = list(updated.get("minimax_refs", [])) + motion_audio
        if "minimax_keyframes" in metadata:
            guides = []
            for guide in metadata["minimax_keyframes"]:
                resized = dict(guide)
                if guide.get("latent") is not None:
                    resized["latent"] = resize_video_latent(guide["latent"], height, width)
                guides.append(resized)
            updated["minimax_keyframes"] = guides
        synced.append([embedding, updated])
    return synced


def budget_reason(video, height, width, total_bytes, free_bytes, positive=(), rebuilt=False):
    if video.ndim != 5 or video.shape[0] != 1 or video.shape[1] != 24:
        return "unsupported H3 latent shape"
    if height <= video.shape[-2] or width <= video.shape[-1]:
        return "no spatial enlargement requested"
    if video.shape[2] > 42:
        return "clip exceeds the conservative 6-second refinement budget"
    if height * width * 256 > 1024 * 1024:
        return "target exceeds the conservative 1 MP refinement limit"
    reference_tokens = 0
    for _, metadata in positive:
        tokens = 0
        for reference in metadata.get("minimax_refs", []):
            tensor = reference.get("latent")
            if tensor is not None:
                growth = max(height / video.shape[-2], width / video.shape[-1]) ** 2 \
                    if reference.get("kind") == "image" and not rebuilt else 1
                tokens += math.ceil(tensor.shape[2] * tensor.shape[-2] * tensor.shape[-1] * growth / 4)
        for guide in metadata.get("minimax_keyframes", []):
            tensor = guide.get("latent")
            if tensor is not None:
                tokens += math.ceil(tensor.shape[2] * height * width / 4)
        reference_tokens = max(reference_tokens, tokens)
    if video.shape[2] * height * width / 4 + reference_tokens > 60_000:
        return "target and references exceed the conservative token budget"
    if total_bytes < 12 * 1024 ** 3 or free_bytes < 6 * 1024 ** 3:
        return "insufficient GPU memory headroom"
    return ""


def save_base_video(video, filename_prefix):
    import folder_paths
    from comfy_api.latest import Types

    if not filename_prefix.startswith("video/mijing-studio-") or ".." in filename_prefix:
        raise ValueError("Invalid Studio output prefix")
    width, height = video.get_dimensions()
    directory, basename, counter, subfolder, _ = folder_paths.get_save_image_path(
        filename_prefix + "-base", folder_paths.get_output_directory(), width, height)
    filename = f"{basename}_{counter:05}_.mp4"
    video.save_to(os.path.join(directory, filename), format=Types.VideoContainer("mp4"),
                  codec=Types.VideoCodec("h264"))
    return {"filename": filename, "subfolder": subfolder, "type": "output"}


class MijingH3PreserveVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            "filename_prefix": ("STRING", {"default": "video/mijing-studio-refine"}),
        }}

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "preserve"
    CATEGORY = "Mijing Studio/MiniMax H3"
    OUTPUT_NODE = True

    def preserve(self, video, filename_prefix):
        snapshot = save_base_video(video, filename_prefix)
        return {"ui": {"images": [snapshot]}, "result": (video,)}


class MijingH3VideoTail:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "max_frames": ("INT", {"default": 124, "min": 5, "max": 3600}),
            "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0}),
        }, "optional": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    FUNCTION = "tail"
    CATEGORY = "Mijing Studio/MiniMax H3"

    def tail(self, images, max_frames, fps=24.0, audio=None):
        fps = bounded_number(fps, 24.0, 1.0, 240.0)
        available = min(int(max_frames), math.floor(images.shape[0] * 24 / fps))
        if available < 5:
            raise ValueError("H3 continuation video needs at least 5 frames")
        count = 5 + ((available - 5) // 17) * 17
        indices = images.shape[0] - 1 - torch.arange(count - 1, -1, -1, device=images.device) * fps / 24
        frames = images[indices.round().long().clamp(0, images.shape[0] - 1)]
        soundtrack = None
        if audio is not None:
            sample_rate = int(audio["sample_rate"])
            end_time = images.shape[0] / fps
            start = max(0, round((end_time - count / 24) * sample_rate))
            end = round(end_time * sample_rate)
            waveform = audio["waveform"][..., start:end]
            if waveform.shape[-1]:
                soundtrack = {**audio, "waveform": waveform}
        return (frames, soundtrack)


class MijingH3SafeRefine:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "base_video": ("VIDEO",), "latent": ("LATENT",), "positive": ("CONDITIONING",),
            "model": ("MODEL",), "vae": ("VAE",), "clip": ("CLIP",), "audio_vae": ("VAE",),
            "prompt": ("STRING", {"multiline": True}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            "scale": ("FLOAT", {"default": 1.25, "min": 1.0, "max": 1.25}),
            "steps": ("INT", {"default": 2, "min": 1, "max": 4}),
            "denoise": ("FLOAT", {"default": 0.2, "min": 0.1, "max": 0.3}),
            "trim_frames": ("INT", {"default": 0, "min": 0, "max": 240}),
        }, "optional": {
            **{f"reference_image_{index}": ("IMAGE",) for index in range(9)},
            "reference_video": ("IMAGE",), "reference_audio": ("AUDIO",),
        }}

    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("video", "report")
    FUNCTION = "refine"
    CATEGORY = "Mijing Studio/MiniMax H3"

    def refine(self, base_video, latent, positive, model, vae, clip, audio_vae, prompt, seed,
               scale=1.25, steps=2, denoise=0.2, trim_frames=0, **references):
        import comfy.model_management as management

        touched_gpu = False
        try:
            samples = latent["samples"]
            if not getattr(samples, "is_nested", False) or len(samples.tensors) != 2:
                return self.result(base_video, "base-only: not an H3 AV latent")
            source_video, source_audio = samples.tensors
            height, width = target_size(source_video, scale)
            reason = budget_reason(source_video, height, width, math.inf, math.inf, positive)
            if reason:
                return self.result(base_video, f"base-only: {reason}")
            device = management.get_torch_device()
            if device.type != "cuda":
                return self.result(base_video, "base-only: refinement requires a CUDA device")
            touched_gpu = True
            management.unload_all_models()
            gc.collect()
            management.soft_empty_cache()
            total_bytes = torch.cuda.get_device_properties(device).total_memory
            free_bytes = management.get_free_memory(device)
            reason = budget_reason(source_video, height, width, total_bytes, free_bytes, positive)
            if reason:
                return self.result(base_video, f"base-only: {reason}")
            video = self.render(base_video, source_video, source_audio, positive, model, vae,
                                clip, audio_vae, prompt, references, seed, height, width, steps, denoise, trim_frames)
            return self.result(video, f"refined: {width * 16}x{height * 16}; Euler/simple; original audio")
        except Exception as error:
            report = f"base-only: refinement failed ({type(error).__name__}: {error}); original video retained"
        finally:
            try:
                if touched_gpu:
                    management.unload_all_models()
                gc.collect()
                management.soft_empty_cache()
            except Exception:
                pass
        return self.result(base_video, report)

    def render(self, base_video, source_video, source_audio, positive, model, vae,
               clip, audio_vae, prompt, references, seed, height, width, steps, denoise, trim_frames):
        import nodes
        import comfy.nested_tensor
        import comfy.model_management as management
        from comfy_api.latest import InputImpl, Types
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo

        enlarged = resize_video_latent(source_video, height, width)
        image_refs = {f"ref_image_{index}": references[f"reference_image_{index}"]
                      for index in range(9) if references.get(f"reference_image_{index}") is not None}
        reference_video = references.get("reference_video")
        reference_audio = references.get("reference_audio")
        actual_kinds = ["image"] * len(image_refs)
        if reference_video is not None:
            actual_kinds.append("video_audio" if reference_audio is not None else "video")
        for _, metadata in positive:
            expected_kinds = [reference.get("kind") for reference in metadata.get("minimax_refs", [])
                              if "motion_context_audio_end_frame" not in reference]
            if actual_kinds != expected_kinds:
                raise ValueError("Reference binding mismatch; refusing refinement with missing assets or changed media kinds")
        frame_count = round((source_video.shape[2] - 2) * 17 / 5 + 5)
        with torch.inference_mode():
            rebuilt = MiniMaxH3ReferenceToVideo.execute(
                clip=clip, vae=vae, audio_vae=audio_vae, prompt=prompt,
                width=width * 16, height=height * 16, length=frame_count, ref_image_size="match",
                ref_images=image_refs,
                ref_videos={"ref_video_0": reference_video} if reference_video is not None else {},
                ref_video_audios={"ref_video_audio_0": reference_audio} if reference_audio is not None else {})
        conditioning = sync_conditioning(positive, rebuilt[0], height, width)
        del rebuilt
        reason = budget_reason(source_video, height, width, math.inf, math.inf, conditioning, rebuilt=True)
        if reason:
            raise ValueError(reason)
        management.unload_all_models()
        gc.collect()
        management.soft_empty_cache()
        original_audio = source_audio.detach().to(device="cpu")
        refined_input = {"samples": comfy.nested_tensor.NestedTensor((enlarged, original_audio))}
        steps = int(bounded_number(steps, 2, 1, 4))
        denoise = bounded_number(denoise, 0.2, 0.1, min(0.3, steps / (steps + 1)))
        with torch.inference_mode():
            sampled = nodes.common_ksampler(model, int(seed), steps, 1.0, "euler", "simple",
                                            conditioning, [], refined_input, denoise=denoise)[0]
            refined_video = sampled["samples"].tensors[0].detach().to(device="cpu")
            del sampled, refined_input, enlarged, conditioning
            management.unload_all_models()
            management.soft_empty_cache()
            frames = nodes.VAEDecodeTiled().decode(
                vae, {"samples": refined_video}, tile_size=256, overlap=64,
                temporal_size=32, temporal_overlap=8)[0]
        components = base_video.get_components()
        length = components.images.shape[0]
        trim_frames = max(0, int(trim_frames))
        if frames.shape[0] < trim_frames + length:
            raise ValueError("Refined video is shorter than the original; refusing duration drift")
        frames = frames[trim_frames:trim_frames + length].detach().cpu()
        if not torch.isfinite(frames).all():
            raise ValueError("Non-finite pixels in refinement output")
        return InputImpl.VideoFromComponents(Types.VideoComponents(
            images=frames, audio=components.audio, frame_rate=components.frame_rate),
            bit_depth=base_video.get_bit_depth(), color_space=base_video.get_color_space())

    @staticmethod
    def result(video, report):
        print(f"[Mijing H3 refinement] {report}", flush=True)
        ui = {"text": [report]}
        return {"ui": ui, "result": (video, report)}


NODE_CLASS_MAPPINGS = {
    "MijingH3SafeRefine": MijingH3SafeRefine,
    "MijingH3PreserveVideo": MijingH3PreserveVideo,
    "MijingH3VideoTail": MijingH3VideoTail,
}
NODE_DISPLAY_NAME_MAPPINGS = {"MijingH3SafeRefine": "Studio H3 Safe Latent Refine"}
