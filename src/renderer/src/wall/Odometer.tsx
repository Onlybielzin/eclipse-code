const fmt = (n: number) => n.toLocaleString('pt-BR')

/** Numero com digitos que rolam. Cada coluna e uma fita 0-9 deslocada por CSS. */
export function Odometer({ value, label }: { value: number; label: string }) {
  const chars = [...fmt(value)]
  return (
    <div className="odo" role="img" aria-label={label}>
      {chars.map((ch, i) => {
        // Chave pela posicao a partir da direita: o digito das unidades mantem a coluna.
        const key = chars.length - i
        return ch >= '0' && ch <= '9' ? (
          <span key={key} className="odo-col" aria-hidden="true">
            <span className="odo-strip" style={{ transform: `translateY(${-Number(ch)}em)` }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={key} className="odo-sep" aria-hidden="true">
            {ch}
          </span>
        )
      })}
    </div>
  )
}
