

/**
 * audioMONASTRY-Logo – aus public/assets/logo.webp.
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
      src="/assets/logo.webp"
      width={size}
      height={size}
      alt="audioMONASTRY"
      className={`object-contain bg-black ${rounded ? 'rounded-xl' : ''} ${glow ? 'teal-glow' : 'shadow-[0_4px_20px_-6px_rgba(20,184,201,0.4)]'} ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
