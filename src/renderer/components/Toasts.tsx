import { useToastStore } from '../state/toastStore'

/** Bottom-center stack of transient notifications (import errors, etc.). Replaces blocking
 *  `alert()` popups with a non-modal "slash" message the user can read and dismiss. */
export default function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          {t.kind === 'success' && (
            <svg className="toast-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <circle cx="10" cy="10" r="9" fill="currentColor" />
              <path d="M5.8 10.4l2.7 2.7 5.7-5.9" fill="none" stroke="#0e1a14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span className="toast-message">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" title="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
