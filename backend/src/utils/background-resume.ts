export function canResumeBackgroundTasks(reason = 'startup', environment: NodeJS.ProcessEnv = process.env) {
  return environment.MIJING_AUTO_RESUME !== '0' || !['startup', 'api', 'api-get', 'api-list'].includes(reason)
}
