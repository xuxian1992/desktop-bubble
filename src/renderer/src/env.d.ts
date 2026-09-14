import type { BubbleApi } from '../../shared/types'

declare global {
  interface Window {
    bubble: BubbleApi
  }
}

export {}
