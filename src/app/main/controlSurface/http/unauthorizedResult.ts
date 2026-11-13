import { createAppErrorDescriptor } from '../../../../shared/errors/appError'
import type { ControlSurfaceInvokeResult } from '../../../../shared/contracts/controlSurface'

export function buildUnauthorizedResult(): ControlSurfaceInvokeResult<unknown> {
  return {
    __eclipseCodeControlEnvelope: true,
    ok: false,
    error: createAppErrorDescriptor('control_surface.unauthorized'),
  }
}
