import React from 'react'
import { createPortal } from 'react-dom'
import { useShellWallLayer } from '@app/renderer/shell/shellWallLayer'
import eclipseWallpaperUrl from '@app/renderer/assets/eclipse-wallpaper.jpg?url'

/**
 * The Eclipse wallpaper: a still photo that fills the window behind the shell, like the pixel
 * wall, so the top bar and sidebar float on it as glass. Outside the shell it stays inside the
 * canvas. A wine scrim keeps text on chrome glass readable over the photo's bright rim.
 */
export const WorkspaceWallpaper = React.memo(
  function WorkspaceWallpaper(): React.JSX.Element | null {
    const layer = useShellWallLayer()
    if (layer === null) {
      return null
    }
    const wallpaper = (
      <div
        className="workspace-canvas-wallpaper"
        data-testid="workspace-canvas-wallpaper"
        aria-hidden="true"
        style={{ ['--workspace-canvas-wallpaper' as string]: `url(${eclipseWallpaperUrl})` }}
      />
    )
    return layer ? createPortal(wallpaper, layer) : wallpaper
  },
)
