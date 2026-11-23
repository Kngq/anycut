import { create } from 'zustand'

export type ToastKind = 'error' | 'info' | 'success'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** Optional button on the toast (e.g. "Show in Finder"). */
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  /** Shows a toast; auto-dismisses after `ttlMs` (default 7s for errors so there's time to read). */
  push: (kind: ToastKind, message: string, ttlMs?: number, action?: Toast['action']) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, ttlMs = 7000, action) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }))
    if (ttlMs > 0) {
      setTimeout(() => get().dismiss(id), ttlMs)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
