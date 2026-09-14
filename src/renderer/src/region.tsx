import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './region.css'

interface Pt { x: number; y: number }
interface Box { x: number; y: number; width: number; height: number }

function boxOf(a: Pt, b: Pt): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function Region() {
  const start = useRef<Pt | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const done = useRef(false)

  const finish = useCallback((b: Box | null) => {
    if (done.current) return
    done.current = true
    if (!b || b.width < 8 || b.height < 8) window.bubble.finishRegion(null)
    else window.bubble.finishRegion(b)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish])

  const onDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    setBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!start.current) return
    setBox(boxOf(start.current, { x: e.clientX, y: e.clientY }))
  }
  const onUp = (e: React.PointerEvent): void => {
    if (!start.current) return
    const b = boxOf(start.current, { x: e.clientX, y: e.clientY })
    start.current = null
    finish(b)
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0 }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={(e) => { e.preventDefault(); finish(null) }}
    >
      {box === null ? <div className="veil" /> : null}
      {box && box.width > 0 ? (
        <>
          <div className="sel" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
          <div className="dim" style={{ left: box.x, top: Math.max(6, box.y - 24) }}>
            {Math.round(box.width)} × {Math.round(box.height)}
          </div>
        </>
      ) : null}
      <div className="hint">拖拽选择要提问的区域 · <b>Esc</b> 或右键取消</div>
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<Region />)
