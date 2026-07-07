// ============================================
// FIX: react-is patch for jsPDF compatibility
// ============================================

// Define types for the react-is patch
interface ReactIsPatch {
  isElement: (value: any) => boolean;
  isValidElementType: (type: any) => boolean;
  isFragment: (value: any) => boolean;
}

// Check if react-is already exists on window
const existingReactIs = (window as any).reactIs;

// Only apply patch if react-is is missing
if (!existingReactIs || typeof existingReactIs.isElement !== 'function') {
  const patch: ReactIsPatch = {
    isElement: (value: any): boolean => {
      return value && 
             typeof value === 'object' && 
             value.$$typeof === Symbol.for('react.element');
    },
    isValidElementType: (type: any): boolean => {
      return typeof type === 'function' || 
             typeof type === 'string' ||
             (type && typeof type === 'object' && type.$$typeof === Symbol.for('react.memo'));
    },
    isFragment: (value: any): boolean => {
      return value && 
             value.$$typeof === Symbol.for('react.fragment');
    },
  };

  // Assign the patch to window
  (window as any).reactIs = patch;
  console.log('✅ react-is patch applied successfully');
} else {
  console.log('✅ react-is already present, skipping patch');
}

// Export a no-op function for compatibility
export const reactIsPatch = (): void => {
  // Patch already applied, nothing to do
};

export default reactIs;