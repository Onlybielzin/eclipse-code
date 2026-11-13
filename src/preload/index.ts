import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT_CHANNEL,
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNEL,
  type EclipseApi,
  type IpcEventChannel,
  type IpcEventMessage,
} from '@shared/ipc'

const allowedEvents = new Set<string>(IPC_EVENT_CHANNELS)

const api: EclipseApi = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, { channel, input }),
  on: (channel, listener) => {
    if (!allowedEvents.has(channel)) throw new Error(`evento IPC desconhecido: ${channel}`)
    const handler = (_event: IpcRendererEvent, message: IpcEventMessage) => {
      if (message?.channel === (channel as IpcEventChannel)) {
        ;(listener as (payload: unknown) => void)(message.payload)
      }
    }
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler)
    }
  },
}

contextBridge.exposeInMainWorld('eclipse', api)
