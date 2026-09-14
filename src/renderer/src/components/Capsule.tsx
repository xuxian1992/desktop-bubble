/** 胶囊形态：只剩一个球 + 状态点。点它展开成气泡。 */
export function Capsule({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="capsule">
      <div className="orb" onClick={onExpand} title="展开">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.2A.6.6 0 0 1 4 18.7V6.5Z"
            fill="#fff"
          />
        </svg>
        <span className="pip" />
      </div>
    </div>
  )
}
