// src/hooks/useFeature.ts
// Split out of components/FeatureGate.tsx: that file must export only the
// FeatureGate component for Fast Refresh to work, so this hook (which reads
// the same rollbackManager/FeatureFlags) lives here instead.

import React from 'react';
import { rollbackManager, FeatureFlags } from '../utils/rollback';

export const useFeature = (feature: keyof FeatureFlags) => {
  const [enabled, setEnabled] = React.useState(rollbackManager.isEnabled(feature));

  const toggle = React.useCallback(() => {
    const newState = rollbackManager.toggleFeature(feature);
    setEnabled(newState);
  }, [feature]);

  const enable = React.useCallback(() => {
    rollbackManager.enableFeature(feature);
    setEnabled(true);
  }, [feature]);

  const disable = React.useCallback(() => {
    rollbackManager.disableFeature(feature);
    setEnabled(false);
  }, [feature]);

  return { enabled, toggle, enable, disable };
};
