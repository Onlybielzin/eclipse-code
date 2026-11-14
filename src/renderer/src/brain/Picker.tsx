import { useEffect, useId, useRef, useState } from 'react'

export interface PickerOption<T extends string> {
  id: T
  label: string
  hint?: string
}

/**
 * Dropdown no tema do cérebro (o <select> nativo abre a lista do sistema,
 * clara e fora do visual). Teclado: setas, Home/End, Enter/Espaço, Esc.
 */
export function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 1,
}: {
  label: string
  value: T
  options: PickerOption<T>[]
  onChange: (v: T) => void
  columns?: 1 | 2
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const current = options.find((o) => o.id === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.id === value),
      ),
    )
    list.current?.focus()
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open, options, value])

  const pick = (k: number) => {
    onChange(options[k]!.id)
    setOpen(false)
    button.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent) => {
    const step = (d: number) => setActive((a) => (a + d + options.length) % options.length)
    if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'ArrowRight' && columns === 2) step(Math.ceil(options.length / 2))
    else if (e.key === 'ArrowLeft' && columns === 2) step(-Math.ceil(options.length / 2))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(options.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      if (e.key === 'Escape') button.current?.focus()
      return
    } else return
    e.preventDefault()
  }

  return (
    <div
      className={`look picker ${open ? 'open' : ''}`}
      ref={root}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        id={`${id}-b`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="cap" id={`${id}-l`}>
          {label}
        </span>
        <span className="val">
          {current!.label}
          <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
            <path
              d="M1 1l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <ul
          ref={list}
          className={`picker-menu ${columns === 2 ? 'two' : ''}`}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${id}-l`}
          aria-activedescendant={`${id}-o${active}`}
          onKeyDown={onKey}
          style={
            columns === 2
              ? { gridTemplateRows: `repeat(${Math.ceil(options.length / 2)}, auto)` }
              : undefined
          }
        >
          {options.map((o, k) => (
            <li
              key={o.id}
              id={`${id}-o${k}`}
              role="option"
              aria-selected={o.id === value}
              className={k === active ? 'active' : ''}
              onPointerEnter={() => setActive(k)}
              onClick={() => pick(k)}
            >
              <span className="check" aria-hidden="true">
                {o.id === value && (
                  <svg viewBox="0 0 12 10" width="12" height="10">
                    <path
                      d="M1 5l3.5 3.5L11 1"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="txt">
                {o.label}
                {o.hint && <small>{o.hint}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
