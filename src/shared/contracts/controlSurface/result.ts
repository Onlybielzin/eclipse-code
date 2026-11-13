import type { AppErrorDescriptor } from '../dto'

export interface ControlSurfaceSuccessResult<T> {
  __eclipseCodeControlEnvelope: true
  ok: true
  value: T
}

export interface ControlSurfaceFailureResult {
  __eclipseCodeControlEnvelope: true
  ok: false
  error: AppErrorDescriptor
}

export type ControlSurfaceInvokeResult<T> =
  | ControlSurfaceSuccessResult<T>
  | ControlSurfaceFailureResult
