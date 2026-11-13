import type { AppErrorDescriptor } from '../dto'

export interface IpcSuccessResult<T> {
  __eclipseCodeIpcEnvelope: true
  ok: true
  value: T
}

export interface IpcFailureResult {
  __eclipseCodeIpcEnvelope: true
  ok: false
  error: AppErrorDescriptor
}

export type IpcInvokeResult<T> = IpcSuccessResult<T> | IpcFailureResult
