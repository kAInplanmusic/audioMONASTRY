import React from 'react';

interface AudioMonastryLogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export const AudioMonastryLogo: React.FC<AudioMonastryLogoProps> = ({
  className = '',
  size = 48,
  showText = false,
}) => {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-sky-500 hover:scale-105 transition-transform duration-300"
      >
        {/* Outer Gothic Pointed Arch */}
        <path
          d="M 30,85 L 30,46 A 25,25 0 0,1 50,21 A 25,25 0 0,1 70,46 L 70,85"
          stroke="url(#outerArchGrad)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="drop-shadow-[0_0_8px_rgba(56,189,248,0.3)]"
        />

        {/* Inner Concentric Gothic Arch */}
        <path
          d="M 37.5,85 L 37.5,49 A 15.5,15.5 0 0,1 50,33.5 A 15.5,15.5 0 0,1 62.5,49 L 62.5,85"
          stroke="url(#innerArchGrad)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Solid Baseline */}
        <path
          d="M 15,85 L 85,85"
          stroke="#0ea5e9"
          strokeWidth="3"
          strokeLinecap="round"
        />

        {/* Horizontal Wave Axis (with stylish gaps) */}
        <path
          d="M 15,55 L 29,55 M 39,55 L 61,55 M 71,55 L 85,55"
          stroke="#3b82f6"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.8"
        />

        {/* Left Side Audio Waveform Bars (Vertical, aligned around y=55) */}
        <line x1="10" y1="49" x2="10" y2="61" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="14" y1="44" x2="14" y2="66" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="18" y1="39" x2="18" y2="71" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="22" y1="43" x2="22" y2="67" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="26" y1="48" x2="26" y2="62" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />

        {/* Inside-Arch (Center) Audio Waveform Bars */}
        <line x1="43" y1="41" x2="43" y2="69" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="47" y1="36" x2="47" y2="74" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="51" y1="31" x2="51" y2="79" stroke="#0284c7" strokeWidth="3" strokeLinecap="round" />
        <line x1="55" y1="36" x2="55" y2="74" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="59" y1="41" x2="59" y2="69" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />

        {/* Right Side Audio Waveform Bars */}
        <line x1="74" y1="48" x2="74" y2="62" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="78" y1="43" x2="78" y2="67" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="82" y1="39" x2="82" y2="71" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="86" y1="44" x2="86" y2="66" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="90" y1="49" x2="90" y2="61" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />

        {/* Stylized UI Accent Dots & Lines in the corners (matches original logo) */}
        {/* Left corner accent dashes */}
        <line x1="15" y1="71" x2="25" y2="71" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
        <line x1="15" y1="76" x2="21" y2="76" stroke="#0ea5e9" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
        <line x1="15" y1="81" x2="17" y2="81" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" opacity="0.6" />

        {/* Right corner secondary minimal waveform block */}
        <line x1="75" y1="73" x2="75" y2="81" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        <line x1="78" y1="74" x2="78" y2="80" stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        <line x1="81" y1="72" x2="81" y2="82" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        <line x1="84" y1="75" x2="84" y2="79" stroke="#0ea5e9" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />

        {/* Gradients */}
        <defs>
          <linearGradient id="outerArchGrad" x1="30" y1="21" x2="70" y2="85" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="50%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="innerArchGrad" x1="37.5" y1="33.5" x2="62.5" y2="85" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="100%" stopColor="#0369a1" />
          </linearGradient>
        </defs>
      </svg>

      {showText && (
        <div className="flex flex-col">
          <div className="flex items-baseline gap-1 select-none">
            <span className="text-xl font-sans font-medium text-neutral-400 tracking-tight leading-none">
              sample
            </span>
            <span className="text-xl font-sans font-bold text-sky-500 tracking-tight leading-none">
              MONK
            </span>
          </div>
          <span className="text-[10px] font-mono text-sky-400/80 uppercase tracking-widest mt-1">
            Sound, Samples & Effektmaschine
          </span>
        </div>
      )}
    </div>
  );
};
