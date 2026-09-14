import type { ResizeEdge } from '@shared/types'

const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * 8 向自绘缩放手柄。
 * 拖动时把「屏幕坐标」交给主进程算新 bounds —— 主进程持有起始矩形，
 * 渲染进程只报指针位置，避免累积误差。
 */
export function ResizeHandles() {
  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`rh rh-${edge}`}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            window.bubble.beginResize(edge, e.screenX, e.screenY)
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
            window.bubble.resizeTo(e.screenX, e.screenY)
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
            window.bubble.endResize()
          }}
          onPointerCancel={() => window.bubble.endResize()}
        />
      ))}
    </>
  )
}
