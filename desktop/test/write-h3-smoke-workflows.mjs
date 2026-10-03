import fs from 'node:fs'
import { ComfyUiVideoAdapter } from '../../backend/src/services/adapters/comfyui-video.ts'

const config = {
  provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local',
  settings: { comfyui: { steps: 6, refinement: { enabled: true } } },
}
const record = {
  id: 9001, model: 'MiniMax-H3-local', prompt: 'subject_definitions:\n<Subject 1> is the object in <Picture 1>.',
  referenceMode: 'multiple', comfyImageNames: { referenceImages: ['fixture.png'] },
  sequenceStepIndex: 4, sequenceRunId: 9000, comfyVideoName: 'fixture.mp4',
  duration: 5, megapixels: 0.5, comfyH3RefinementAvailable: true, comfyH3VideoTailAvailable: true,
}
const adapter = new ComfyUiVideoAdapter()
const workflows = {
  standard: adapter.buildGenerateRequest(config, { ...record, continuityMode: 'standard_r2v' }).body.prompt,
  first: adapter.buildGenerateRequest(config, { ...record, continuityMode: 'standard_r2v', sequenceStepIndex: 0 }).body.prompt,
  plus: adapter.buildGenerateRequest(config, { ...record, continuityMode: 'latent_plus', latentPath: 'h3_context/smoke', latentClipIndex: 5 }).body.prompt,
}
fs.writeFileSync(process.argv[2], JSON.stringify(workflows, null, 2))
console.log('Wrote 3 validation-only graphs; no requests submitted')
