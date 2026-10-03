import asyncio
import json
import pathlib
import sys
import tempfile
from fractions import Fraction


graph_path = pathlib.Path(sys.argv[1])
sys.argv = [sys.argv[0], "--cpu"]
import comfy.options
comfy.options.enable_args_parsing()
from comfy.cli_args import args
args.cpu = True

import torch
import nodes
import execution
import folder_paths
from PIL import Image
from comfy_api.latest import InputImpl, Types


async def main():
    root = pathlib.Path(nodes.__file__).parent
    modules = [root / "comfy_extras" / filename for filename in [
        "nodes_minimax_h3.py", "nodes_custom_sampler.py", "nodes_audio.py", "nodes_video.py",
    ]]
    modules.extend([root / "custom_nodes" / "ComfyUI-MiniMax-H3-Turbo", root / "custom_nodes" / "ComfyUI-H3-Motion-Context"])
    modules.append(pathlib.Path(__file__).resolve().parents[1] / "comfyui-nodes" / "mijing_h3_safe")
    for module in modules:
        if not await nodes.load_custom_node(str(module)):
            raise RuntimeError(f"Could not register {module.name}")
    for name in ["MijingH3SafeRefine", "MijingH3PreserveVideo", "MijingH3VideoTail"]:
        node = nodes.NODE_CLASS_MAPPINGS[name]
        print(f"Registered {name}: inputs={list(node.INPUT_TYPES()['required'])}; outputs={node.RETURN_TYPES}")
    with tempfile.TemporaryDirectory() as directory:
        folder_paths.set_input_directory(directory)
        Image.new("RGB", (32, 32), "red").save(pathlib.Path(directory) / "fixture.png")
        clip = InputImpl.VideoFromComponents(Types.VideoComponents(images=torch.zeros((22, 32, 32, 3)), audio=None, frame_rate=Fraction(24)))
        clip.save_to(str(pathlib.Path(directory) / "fixture.mp4"), format=Types.VideoContainer("mp4"), codec=Types.VideoCodec("h264"))
        graphs = json.loads(graph_path.read_text(encoding="utf-8"))
        for name, graph in graphs.items():
            result = await execution.validate_prompt(f"offline-{name}", graph, None)
            if not result[0] or result[3]:
                raise RuntimeError(json.dumps({"graph": name, "validation": result}, ensure_ascii=False, default=str))
            print(f"Validated {name}: {len(graph)} nodes; outputs={result[2]}")
    print("PASS: CPU-only node registration and real ComfyUI graph validation; no models loaded or jobs submitted")


asyncio.run(main())
