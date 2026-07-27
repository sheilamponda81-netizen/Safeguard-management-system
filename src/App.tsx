import { useState, useEffect, lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { Toaster } from "sonner";
import { LoginPage } from "./pages/Login";
import { Sidebar, TopBar, BottomNav, NavKey } from "./components/Sidebar";
import { supabase } from "./lib/supabase";
import { getCurrentProfile } from "./utils/currentProfile";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startMonitoring } from "./utils/alerts";
import { logger } from "./utils/logger";
import { PageLoader } from "./components/PageLoader";
import { measurePerformance } from "./utils/performance";

// ===== PERFORMANCE: NO PRELOADING - Only load when needed =====
const safeLazy = (importFn: () => Promise<any>) => {
  return lazy(() =>
    importFn().catch((error) => {
      console.error('Failed to load component:', error);
      return {
        default: () => (
          <div className="p-8 text-center">
            <div className="text-red-600 text-4xl mb-4">⚠️</div>
            <p className="text-red-600 font-semibold">Failed to load component</p>
            <p className="text-sm text-slate-500 mt-2">Please refresh the page</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-[#081C3A] text-white rounded-lg hover:bg-[#1a2f5c]"
            >
              Refresh Page
            </button>
          </div>
        )
      };
    })
  );
};

// ===== LAZY LOAD PAGES =====
const Dashboard = safeLazy(() => import("./pages/Dashboard"));
const EmployeesPage = safeLazy(() => import("./pages/Employees"));
const RecruitmentPage = safeLazy(() => import("./pages/Recruitment"));
const AttendancePage = safeLazy(() => import("./pages/Attendance"));
const PayrollPage = safeLazy(() => import("./pages/Payroll"));
const PayslipsPage = safeLazy(() => import("./pages/Payslips"));
const PaymentsPage = safeLazy(() => import("./pages/Payments"));
const ReportsPage = safeLazy(() => import("./pages/Reports"));
const SecurityPage = safeLazy(() => import("./pages/Security"));
const SettingsPage = safeLazy(() => import("./pages/Misc"));
const AuditLogsPage = safeLazy(() => import("./pages/AuditLogs"));
const TerminalDuesPage = safeLazy(() => import("./pages/TerminalDues"));
const FeaturesPage = safeLazy(() => import("./pages/Features"));
const UserManualPage = safeLazy(() => import("./pages/UserManual"));

// ===== PAGE COMPONENTS MAP =====
const pageComponents: Record<NavKey, React.LazyExoticComponent<() => JSX.Element>> = {
  dashboard: Dashboard,
  employees: EmployeesPage,
  recruitment: RecruitmentPage,
  attendance: AttendancePage,
  payroll: PayrollPage,
  payslips: PayslipsPage,
  payments: PaymentsPage,
  "terminal-dues": TerminalDuesPage,
  reports: ReportsPage,
  settings: SettingsPage,
  security: SecurityPage,
  features: FeaturesPage,
  auditlogs: AuditLogsPage,
  "user-manual": UserManualPage,
};

// ===== ROLE CONFIGURATION =====
const rolePages: Record<number, NavKey[]> = {
  1: [
    "dashboard", "employees", "recruitment", "attendance",
    "payroll", "payslips", "payments", "terminal-dues",
    "reports", "settings", "security", "features", "auditlogs",
    "user-manual",
  ],
  2: [
    "dashboard", "employees", "recruitment", "attendance",
    "payments", "terminal-dues", "reports", "security",
    "user-manual",
  ],
  3: ["dashboard", "attendance", "security", "user-manual"],
  4: ["dashboard", "payslips", "user-manual"],
};

// ===== TITLES CONFIGURATION =====
const titles: Record<NavKey, { title: string; breadcrumb: string }> = {
  dashboard: { title: "Dashboard Overview", breadcrumb: "Dashboard" },
  employees: { title: "Employee Management", breadcrumb: "Employees" },
  recruitment: { title: "Recruitment Pipeline", breadcrumb: "Recruitment" },
  attendance: { title: "Attendance Management", breadcrumb: "Attendance" },
  payroll: { title: "Payroll Management", breadcrumb: "Payroll" },
  payslips: { title: "Payslips", breadcrumb: "Payslips" },
  payments: { title: "Payment Management", breadcrumb: "Payments" },
  "terminal-dues": { title: "Terminal Dues Calculator", breadcrumb: "Terminal Dues" },
  reports: { title: "Reports & Analytics", breadcrumb: "Reports" },
  settings: { title: "System Settings", breadcrumb: "Settings" },
  security: { title: "Security Personnel", breadcrumb: "Security" },
  features: { title: "Future Features", breadcrumb: "Roadmap" },
  auditlogs: { title: "Audit Logs", breadcrumb: "Audit Logs" },
  "user-manual": { title: "User Manual", breadcrumb: "User Manual" },
};

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nav, setNav] = useState<NavKey>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userRoleLevel, setUserRoleLevel] = useState<number>(4);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [preloaded, setPreloaded] = useState<Set<NavKey>>(new Set());

  // ===== OPTIMIZED: Use useCallback for navigation =====
  const handleNavigate = useCallback((key: NavKey) => {
    setNav(key);
    setMobileOpen(false);
  }, []);

  const handleLogin = useCallback(() => {
    setLoggedIn(true);
  }, []);

  // ===== PERFORMANCE: Only preload on hover =====
  const handlePreload = useCallback((key: NavKey) => {
    if (preloaded.has(key)) return;
    
    const component = pageComponents[key];
    if (component) {
      setPreloaded(prev => new Set(prev).add(key));
    }
  }, [preloaded]);

  // ===== OPTIMIZED: Use useMemo for allowed pages =====
  const allowedPages = useMemo(() => {
    return rolePages[userRoleLevel] || rolePages[4];
  }, [userRoleLevel]);

  // ===== OPTIMIZED: Use useMemo for titles =====
  const currentTitle = useMemo(() => {
    return titles[nav]?.title || "Dashboard";
  }, [nav]);

  const currentBreadcrumb = useMemo(() => {
    return titles[nav]?.breadcrumb || "Dashboard";
  }, [nav]);

  // ===== OPTIMIZED: Render ONLY the current page =====
  const renderPage = useCallback(() => {
    if (!allowedPages.includes(nav)) {
      return <Dashboard />;
    }

    const Component = pageComponents[nav];
    if (!Component) {
      return <Dashboard />;
    }

    return (
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    );
  }, [nav, allowedPages]);

  // ===== SESSION CHECK =====
  useEffect(() => {
    const perf = measurePerformance('App Initial Load');
    startMonitoring();
    if (process.env.NODE_ENV === 'production') {
      logger.info('Application started', { version: '2.0.0' });
    }
    perf.end();
  }, []);

  // ===== SESSION CHECK WITH CACHING =====
  useEffect(() => {
    let isMounted = true;

    const checkSession = async () => {
      try {
        const cachedSession = sessionStorage.getItem('sb-session-cache');
        if (cachedSession && !sessionChecked) {
          try {
            const parsed = JSON.parse(cachedSession);
            if (parsed && parsed.user) {
              setLoggedIn(true);
              setUserRoleLevel(parsed.role_level || 4);
              setLoading(false);
              setSessionChecked(true);
              return;
            }
          } catch (e) {
            console.error('Error parsing cached session:', e);
          }
        }

        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) {
          console.error('Session error:', error);
          setLoggedIn(false);
          setLoading(false);
          setSessionChecked(true);
          return;
        }

        if (isMounted) {
          if (session) {
            setLoggedIn(true);
            localStorage.setItem('sb-session', JSON.stringify(session));
            
            const profile = await getCurrentProfile();

            const roleLevel = profile?.role_level || 4;
            setUserRoleLevel(roleLevel);
            
            sessionStorage.setItem('sb-session-cache', JSON.stringify({
              user: session.user,
              role_level: roleLevel
            }));
          } else {
            setLoggedIn(false);
            localStorage.removeItem('sb-session');
            sessionStorage.removeItem('sb-session-cache');
          }
          setLoading(false);
          setSessionChecked(true);
        }
      } catch (err: any) {
        console.error('Session check failed:', err);
        setLoggedIn(false);
        setLoading(false);
        setSessionChecked(true);
      }
    };

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isMounted) return;
      
      if (event === 'SIGNED_IN' && session) {
        setLoggedIn(true);
        localStorage.setItem('sb-session', JSON.stringify(session));
        
        const profile = await getCurrentProfile();

        const roleLevel = profile?.role_level || 4;
        setUserRoleLevel(roleLevel);
        sessionStorage.setItem('sb-session-cache', JSON.stringify({
          user: session.user,
          role_level: roleLevel
        }));
        setLoading(false);
        setSessionChecked(true);
      } else if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
        setLoggedIn(false);
        setUserRoleLevel(4);
        localStorage.removeItem('sb-session');
        sessionStorage.removeItem('sb-session-cache');
        setLoading(false);
        setSessionChecked(true);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Fallback timeout
  useEffect(() => {
    const forceLoadingTimeout = setTimeout(() => {
      if (loading) {
        console.warn('Loading forced to complete after 15 seconds');
        setLoading(false);
        setSessionChecked(true);
        
        const cachedSession = sessionStorage.getItem('sb-session-cache');
        if (cachedSession) {
          try {
            const parsed = JSON.parse(cachedSession);
            if (parsed && parsed.user) {
              setLoggedIn(true);
              setUserRoleLevel(parsed.role_level || 4);
              return;
            }
          } catch (e) {
            console.error('Error parsing cached session:', e);
          }
        }
        setLoggedIn(false);
      }
    }, 15000);

    return () => clearTimeout(forceLoadingTimeout);
  }, [loading]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#081C3A] to-[#1a2f5c] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#D4A017] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white/80">Loading secure portal...</p>
        </div>
      </div>
    );
  }

  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (!allowedPages.includes(nav)) {
    setTimeout(() => setNav("dashboard"), 0);
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#F8FAFC] flex">
        <Sidebar
          active={nav}
          onNavigate={handleNavigate}
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          onPreload={handlePreload}
        />
        <div className="flex-1 flex flex-col w-0">
          <TopBar
            title={currentTitle}
            breadcrumb={currentBreadcrumb}
            onMenuClick={() => setMobileOpen(true)}
          />
          <main className="flex-1 overflow-auto p-4 md:p-6">
            {renderPage()}
          </main>
          <BottomNav active={nav} onNavigate={handleNavigate} />
        </div>
        <Toaster position="top-right" richColors />
      </div>
    </ErrorBoundary>
  );
}