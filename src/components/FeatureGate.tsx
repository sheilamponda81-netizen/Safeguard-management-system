// src/components/FeatureGate.tsx

import React from 'react';
import { rollbackManager, FeatureFlags } from '../utils/rollback';

interface FeatureGateProps {
  feature: keyof FeatureFlags;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const FeatureGate: React.FC<FeatureGateProps> = ({
  feature,
  children,
  fallback = null
}) => {
  if (!rollbackManager.isEnabled(feature)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
};

// `useFeature` moved to src/hooks/useFeature.ts -- this file exports only the
// FeatureGate component now, which Fast Refresh requires.