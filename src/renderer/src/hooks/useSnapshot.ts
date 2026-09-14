import { useEffect, useState } from 'react'
import type { Snapshot } from '@shared/types'

export function useSnapshot(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  useEffect(() => {
    void window.bubble.getSnapshot().then(setSnap)
    return window.bubble.onSnapshot(setSnap)
  }, [])
  return snap
}
