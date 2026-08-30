import { useState, useEffect } from 'react';

export type DeviceType = 'desktop' | 'tablet' | 'mobile';

export function useDevice(): DeviceType {
  const [device, setDevice] = useState<DeviceType>('desktop');

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      if (width < 768) setDevice('mobile');
      else if (width < 1024) setDevice('tablet');
      else setDevice('desktop');
    };

    window.addEventListener('resize', handleResize);
    handleResize(); // Initial check
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return device;
}
