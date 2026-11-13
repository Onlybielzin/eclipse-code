import type { SshConfigHost } from '@shared/contracts/dto'

export async function loadSshConfigHosts(): Promise<SshConfigHost[]> {
  return await window.eclipseCodeApi.controlSurface.invoke<SshConfigHost[]>({
    kind: 'query',
    id: 'endpoint.sshConfigHosts',
    payload: null,
  })
}
