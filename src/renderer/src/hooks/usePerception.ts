import { useEffect, useState } from 'react'
import type { PerceptionView } from '@shared/types'

export function usePerception(): PerceptionView | null {
  const [p, setP] = useState<PerceptionView | null>(null)
  useEffect(() => {
    void window.bubble.getPerception().then(setP)
    return window.bubble.onPerceptionChanged(setP)
  }, [])
  return p
}
