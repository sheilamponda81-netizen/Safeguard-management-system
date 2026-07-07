// ============================================
// PERFORMANCE REPORT UTILITY
// ============================================

export const generatePerformanceReport = () => {
  console.log('📊 === PERFORMANCE REPORT ===');
  console.log(`📅 Generated: ${new Date().toLocaleString()}`);
  console.log('');

  // Navigation Timing
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    console.log('🔹 Navigation Timing:');
    console.log(`   DNS Lookup: ${Math.round(nav.domainLookupEnd - nav.domainLookupStart)}ms`);
    console.log(`   TCP Connection: ${Math.round(nav.connectEnd - nav.connectStart)}ms`);
    console.log(`   Request: ${Math.round(nav.responseStart - nav.requestStart)}ms`);
    console.log(`   Response: ${Math.round(nav.responseEnd - nav.responseStart)}ms`);
    console.log(`   DOM Interactive: ${Math.round(nav.domInteractive - nav.startTime)}ms`);
    console.log(`   DOM Complete: ${Math.round(nav.domComplete - nav.startTime)}ms`);
    console.log(`   Load Event: ${Math.round(nav.loadEventEnd - nav.startTime)}ms`);
    console.log(`   Total Load: ${Math.round(nav.loadEventEnd - nav.startTime)}ms`);
    console.log('');
  }

  // Paint Metrics
  const paint = performance.getEntriesByType('paint');
  paint.forEach(p => {
    console.log(`🔹 ${p.name}: ${Math.round(p.startTime)}ms`);
  });
  console.log('');

  // Resource Summary
  const resources = performance.getEntriesByType('resource');
  const byType = {
    script: 0,
    style: 0,
    image: 0,
    font: 0,
    other: 0
  };
  
  resources.forEach(r => {
    const type = r.initiatorType || 'other';
    if (type in byType) {
      byType[type as keyof typeof byType]++;
    } else {
      byType.other++;
    }
  });
  
  console.log('🔹 Resources:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`   ${type}: ${count} files`);
  });
  
  const totalSize = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
  console.log(`   Total Transfer Size: ${Math.round(totalSize / 1024)}KB`);
  console.log('');

  // React Specific
  const root = document.getElementById('root');
  if (root) {
    console.log(`🔹 React Root Children: ${root.children.length}`);
  }

  console.log('📊 === END REPORT ===');
};

// Auto-run in development
if (process.env.NODE_ENV === 'development') {
  setTimeout(generatePerformanceReport, 5000);
}