import { toast } from 'vue-sonner'
import { api } from './useApi'

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const error = ref('')
  const errorType = ref<string | null>(null)

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>, options: Record<string, any> = {}) {
    if (running.value) { toast.warning('操作执行中'); return null }
    running.value = true
    runningType.value = type
    error.value = ''
    errorType.value = null
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
        ...options,
      })
      toast.success('完成')
      await onDone?.()
      return data
    } catch (err: any) {
      error.value = err?.message || '操作失败'
      errorType.value = type
      toast.error(error.value)
      return null
    } finally {
      running.value = false
      runningType.value = null
    }
  }

  return { running, runningType, error, errorType, run }
}
