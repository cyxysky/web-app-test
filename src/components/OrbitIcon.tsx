import appIcon from '../../assets/app-icon-small.png';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import styles from './OrbitIcon.module.css';

export function OrbitIcon({ size = 32, className = '', alt = '' }: { size?: number; className?: string; alt?: string }) {
  return (
    <img
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={`orbit-app-icon ${styles.icon} ${className}`.trim()}
      decoding="async"
      draggable={false}
      height={size}
      src={withWebPilotBasePath(appIcon.src)}
      style={{ height: size, width: size }}
      width={size}
    />
  );
}
