// src/components/OptimizedIcon.tsx
import { forwardRef } from 'react';

interface OptimizedIconProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  size?: number;
  className?: string;
}

export const OptimizedIcon = forwardRef<HTMLSpanElement, OptimizedIconProps>(
  ({ icon: Icon, size = 20, className = '' }, ref) => {
    return (
      <span 
        ref={ref}
        className={`icon-container ${className}`}
        style={{ 
          width: size, 
          height: size,
          flexShrink: 0,
        }}
        data-icon="true"
      >
        <Icon size={size} />
      </span>
    );
  }
);

OptimizedIcon.displayName = 'OptimizedIcon';