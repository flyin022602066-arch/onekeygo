/**
 * Fetch remote provider APIs with an Electron network fallback.
 *
 * The packaged Electron runtime occasionally resets Node/undici TLS
 * connections to api.eggfans.org. Chromium's net.fetch uses the same network
 * stack as the renderer and is reliable for that gateway. Plain Node/test
 * runtimes continue to use the regular global fetch.
 */
export async function fetchProvider(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isElectronRuntime() && isEggfansUrl(input)) {
    try {
      return await fetchWithElectronNet(input, init)
    } catch {
      // Retry through Node fetch before surfacing the original provider error.
    }
  }

  try {
    return await fetch(input, init)
  } catch (error) {
    if (!isElectronRuntime()) throw error
    return fetchWithElectronNet(input, init)
  }
}

function isElectronRuntime() {
  return !!(process.versions as Record<string, string | undefined>).electron
}

function isEggfansUrl(input: RequestInfo | URL) {
  try {
    return new URL(String(input)).hostname.toLowerCase() === 'api.eggfans.org'
  } catch {
    return false
  }
}

async function fetchWithElectronNet(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Avoid a static electron import so the backend remains runnable outside
  // Electron (CLI, Docker, and the Node test runner).
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
  const electron = await dynamicImport('electron')
  if (typeof electron?.net?.fetch !== 'function') throw new Error('Electron net.fetch is unavailable')
  return await electron.net.fetch(input, init)
}
