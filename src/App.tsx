import { useState, useEffect, lazy, Suspense, useCallback, useMemo } from "react";
import { Toaster } from "sonner";
import { LoginPage } from "./pages/Login";
import { Sidebar, TopBar, BottomNav, NavKey } from "./components/Sidebar";
import { supabase } from "./lib/supabase";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startMonitoring } from "./utils/alerts";
import { logger } from "./utils/logger";
import { PageLoader } from "./components/PageLoader";
import { measurePerformance } from "./utils/performance";

// ===== SAFE LAZY LOADING WITH ERROR HANDLING =====
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

// ===== LAZY LOAD PAGES WITH SAFE WRAPPER =====
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
};

// ===== ROLE CONFIGURATION =====
const rolePages: Record<number, NavKey[]> = {
  1: [
    "dashboard", "employees", "recruitment", "attendance",
    "payroll", "payslips", "payments", "terminal-dues",
    "reports", "settings", "security", "features", "auditlogs",
  ],
  2: [
    "dashboard", "employees", "recruitment", "attendance",
    "payments", "terminal-dues", "reports", "security",
  ],
  3: ["dashboard", "attendance", "security"],
  4: ["dashboard", "payslips"],
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
};

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nav, setNav] = useState<NavKey>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userRoleLevel, setUserRoleLevel] = useState<number>(4);
  const [sessionChecked, setSessionChecked] = useState(false);

  // ===== OPTIMIZED: Use useCallback for navigation =====
  const handleNavigate = useCallback((key: NavKey) => {
    setNav(key);
    setMobileOpen(false);
  }, []);

  const handleLogin = useCallback(() => {
    setLoggedIn(true);
  }, []);

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

  // ===== OPTIMIZED: Render page using map =====
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

  // ===== SESSION CHECK WITH BETTER ERROR HANDLING =====
  useEffect(() => {
    const perf = measurePerformance('App Initial Load');
    startMonitoring();
    if (process.env.NODE_ENV === 'production') {
      logger.info('Application started', { version: '2.0.0' });
    }
    perf.end();
  }, []);

  // src/App.tsx - Updated session handling

// ===== IMPROVED SESSION CHECK WITH BETTER ERROR HANDLING =====
useEffect(() => {
  let isMounted = true;
  let retryCount = 0;
  const maxRetries = 2;

  const checkSession = async () => {
    try {
      // First, check if we have a session in localStorage
      const storedSession = localStorage.getItem('sb-session');
      if (storedSession && !sessionChecked) {
        try {
          const parsed = JSON.parse(storedSession);
          if (parsed && parsed.access_token) {
            const expiresAt = parsed.expires_at || 0;
            const now = Math.floor(Date.now() / 1000);
            
            // Check if session is still valid (with 5 minute buffer)
            if (expiresAt > now + 300) {
              setLoggedIn(true);
              const { data: { user } } = await supabase.auth.getUser();
              if (user) {
                const { data: profile } = await supabase
                  .from("profiles")
                  .select("role_level")
                  .eq("id", user.id)
                  .single();
                setUserRoleLevel(profile?.role_level || 4);
              }
              setLoading(false);
              setSessionChecked(true);
              return;
            } else {
              // Session expired, clear it
              console.log('Session expired, clearing...');
              localStorage.removeItem('sb-session');
            }
          }
        } catch (e) {
          console.error('Error parsing stored session:', e);
          localStorage.removeItem('sb-session');
        }
      }

      // Try to get session from Supabase with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        clearTimeout(timeoutId);

        if (error) {
          console.error('Session error:', error);
          // If it's a refresh token error, clear the session
          if (error.message?.includes('refresh_token_not_found') || 
              error.status === 400) {
            console.log('Refresh token invalid, clearing session...');
            await supabase.auth.signOut();
            localStorage.removeItem('sb-session');
            setLoggedIn(false);
            setLoading(false);
            setSessionChecked(true);
            return;
          }
          setLoggedIn(false);
          setLoading(false);
          setSessionChecked(true);
          return;
        }

        if (isMounted) {
          if (session) {
            setLoggedIn(true);
            localStorage.setItem('sb-session', JSON.stringify(session));
            
            const { data: profile } = await supabase
              .from("profiles")
              .select("role_level")
              .eq("id", session.user.id)
              .single();
            
            setUserRoleLevel(profile?.role_level || 4);
          } else {
            setLoggedIn(false);
            localStorage.removeItem('sb-session');
          }
          setLoading(false);
          setSessionChecked(true);
        }
      } catch (err: any) {
        clearTimeout(timeoutId);
        
        if (err.name === 'AbortError' || err.message?.includes('timeout')) {
          console.warn('Session check timed out');
          
          // Try localStorage fallback again
          const fallbackSession = localStorage.getItem('sb-session');
          if (fallbackSession) {
            try {
              const parsed = JSON.parse(fallbackSession);
              if (parsed && parsed.access_token) {
                setLoggedIn(true);
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                  const { data: profile } = await supabase
                    .from("profiles")
                    .select("role_level")
                    .eq("id", user.id)
                    .single();
                  setUserRoleLevel(profile?.role_level || 4);
                }
                setLoading(false);
                setSessionChecked(true);
                return;
              }
            } catch (e) {
              console.error('Error parsing fallback session:', e);
            }
          }
          
          // Retry logic
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`Retrying session check (${retryCount}/${maxRetries})...`);
            setTimeout(checkSession, 2000);
            return;
          }
          
          setLoggedIn(false);
          setLoading(false);
          setSessionChecked(true);
        } else if (err.message?.includes('refresh_token_not_found') || 
                   err.status === 400) {
          console.log('Refresh token error, signing out...');
          await supabase.auth.signOut();
          localStorage.removeItem('sb-session');
          setLoggedIn(false);
          setLoading(false);
          setSessionChecked(true);
        } else {
          console.error('Session check error:', err);
          setLoggedIn(false);
          setLoading(false);
          setSessionChecked(true);
        }
      }
    } catch (err: any) {
      console.error('Session check failed:', err);
      setLoggedIn(false);
      setLoading(false);
      setSessionChecked(true);
    }
  };

  // Start session check
  checkSession();

  // Auth state change listener
  const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
    if (!isMounted) return;
    
    console.log('Auth state changed:', event);
    
    if (event === 'SIGNED_IN' && session) {
      setLoggedIn(true);
      localStorage.setItem('sb-session', JSON.stringify(session));
      const { data: profile } = await supabase
        .from("profiles")
        .select("role_level")
        .eq("id", session.user.id)
        .single();
      setUserRoleLevel(profile?.role_level || 4);
      setLoading(false);
      setSessionChecked(true);
    } else if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
      setLoggedIn(false);
      setUserRoleLevel(4);
      localStorage.removeItem('sb-session');
      setLoading(false);
      setSessionChecked(true);
    } else if (event === 'TOKEN_REFRESHED' && session) {
      localStorage.setItem('sb-session', JSON.stringify(session));
    } else if (event === 'INITIAL_SESSION' && !session) {
      // No session found, clear everything
      localStorage.removeItem('sb-session');
      setLoggedIn(false);
      setLoading(false);
      setSessionChecked(true);
    }
  });

  return () => {
    isMounted = false;
    subscription.unsubscribe();
  };
}, []);

  // Fallback timeout to prevent infinite loading
  useEffect(() => {
    const forceLoadingTimeout = setTimeout(() => {
      if (loading) {
        console.warn('Loading forced to complete after 15 seconds');
        setLoading(false);
        setSessionChecked(true);
        
        // Check if we have a session in localStorage
        const storedSession = localStorage.getItem('sb-session');
        if (storedSession) {
          try {
            const parsed = JSON.parse(storedSession);
            if (parsed && parsed.access_token) {
              setLoggedIn(true);
              return;
            }
          } catch (e) {
            console.error('Error parsing stored session:', e);
          }
        }
        setLoggedIn(false);
      }
    }, 15000);

    return () => clearTimeout(forceLoadingTimeout);
  }, [loading]);

  // Loading screen
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

  // Login page
  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Check if nav is allowed
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