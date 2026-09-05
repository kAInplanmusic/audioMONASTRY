

/**
 * audioMONASTRY-Logo – aus public/logofullsize.png (korrektes Logo;
 * logo.webp ist das alte Testlogo und wird nur als Fallback genutzt).
 * `size` steuert die Ausdehnung; optional `glow` für den Start-Effekt.
 */
export function Logo({
  size = 40,
  glow = false,
  rounded = true,
  className = '',
}: {
  size?: number;
  glow?: boolean;
  rounded?: boolean;
  className?: string;
}) {
  return (
    <img
      src="/logofullsize.png"
      width={size}
      height={size}
      alt="audioMONASTRY"
      onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/assets/logo.webp'; }}
      className={`object-contain bg-black ${rounded ? 'rounded-xl' : ''} ${glow ? 'teal-glow' : 'shadow-[0_4px_20px_-6px_rgba(20,184,201,0.4)]'} ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
