import { useState, useEffect, lazy, Suspense, useCallback, useMemo } from "react";
import { Toaster } from "sonner";
import { LoginPage } from "./pages/Login";
import { Sidebar, TopBar, BottomNav, NavKey, resolveAllowedPages } from "./components/Sidebar";
import { supabase } from "./lib/supabase";
import { getCurrentProfile, UserProfile } from "./utils/currentProfile";
import { isBusinessAdmin, getMyPermissions } from "./utils/permissions";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startMonitoring } from "./utils/alerts";
import { logger } from "./utils/logger";
import { PageLoader } from "./components/PageLoader";
import { measurePerformance } from "./utils/performance";

// ===== PERFORMANCE: NO PRELOADING - Only load when needed =====
// Generic over each page module's own default-export type so `pageComponents`
// below reflects what these dynamic imports actually resolve to, instead of
// collapsing every page to `any`.
const safeLazy = <P extends object>(importFn: () => Promise<{ default: React.ComponentType<P> }>) => {
  return lazy(() =>
    importFn().catch((error) => {
      console.error('Failed to load component:', error);
      const LoadFailed: React.ComponentType<P> = () => (
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
      );
      return { default: LoadFailed };
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
const SalaryAdvancesPage = safeLazy(() => import("./pages/SalaryAdvances"));
const FeaturesPage = safeLazy(() => import("./pages/Features"));
const UserManualPage = safeLazy(() => import("./pages/UserManual"));

// HOTFIX: every page is rendered with this one optional prop (see
// renderPage below) -- most pages ignore it entirely (an unused prop is
// harmless), Payslips.tsx is the first to actually use it (its "Go to
// Payroll" button, replacing a hard `window.location.href` navigation
// that 404s against this SPA's lack of a router/rewrite).
interface PageComponentProps {
  onNavigate?: (key: NavKey) => void;
}

// ===== PAGE COMPONENTS MAP =====
const pageComponents: Record<NavKey, React.LazyExoticComponent<React.ComponentType<PageComponentProps>>> = {
  dashboard: Dashboard,
  employees: EmployeesPage,
  recruitment: RecruitmentPage,
  attendance: AttendancePage,
  payroll: PayrollPage,
  payslips: PayslipsPage,
  payments: PaymentsPage,
  "terminal-dues": TerminalDuesPage,
  "salary-advances": SalaryAdvancesPage,
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
    "payroll", "payslips", "payments", "terminal-dues", "salary-advances",
    "reports", "settings", "security", "features", "auditlogs",
    "user-manual",
  ],
  2: [
    "dashboard", "employees", "recruitment", "attendance",
    "payments", "terminal-dues", "salary-advances", "reports", "security",
    "user-manual",
  ],
  3: ["dashboard", "attendance", "security", "user-manual"],
  // "payslips" deliberately removed for role_level 4 (Legacy Staff):
  // profiles has no employee_id link, so payroll RLS cannot express "only
  // this Staff account's own payslip" -- 20260908000000 disables Staff
  // payroll SELECT at the database level as a temporary security
  // restriction (see that migration's header), and this route-guard entry
  // is the matching frontend half so the page is unreachable rather than
  // rendering with zero/blocked data. Restore only once a real profile<->
  // employee identity link exists and can back a genuinely self-scoped policy.
  4: ["dashboard", "user-manual"],
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
  "salary-advances": { title: "Salary Advances", breadcrumb: "Salary Advances" },
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
  const [allowedPages, setAllowedPages] = useState<NavKey[]>(rolePages[4]);
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
    setPreloaded(prev => new Set(prev).add(key));
  }, [preloaded]);

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
        {/* onNavigate is a HOTFIX addition (Payslips' "Go to Payroll" 404
            fix -- this SPA has no router/rewrite for a hard `window.
            location.href` navigation) -- typed loosely as `object` above,
            so an extra prop here is not an error, and every page that
            doesn't declare/use it simply ignores it, same as any unused
            React prop. */}
        <Component onNavigate={handleNavigate} />
      </Suspense>
    );
  }, [nav, allowedPages, handleNavigate]);

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
        // This effect runs once on mount (see its own empty dependency
        // array below), so `sessionChecked` here would always read its
        // initial `false` value regardless of the several setSessionChecked(true)
        // calls below -- it was never a meaningful condition, just dead
        // code left over from an earlier version of this check. Removed
        // rather than added to this effect's deps (which would instead
        // introduce a real bug: re-running this whole effect -- including
        // re-subscribing to onAuthStateChange -- every time sessionChecked
        // flips, which happens multiple times within this same call).
        // The cached-session fast path only short-circuits for a LEGACY
        // account (a real cached role_level number) -- its allowedPages
        // are a pure function of that number, so rolePages[roleLevel] is
        // safe to use instantly without a network round trip. A
        // functional-role account (role_level null/absent from the cache)
        // needs a permissions fetch to know its allowedPages, so it always
        // falls through to the full check below instead.
        const cachedSession = sessionStorage.getItem('sb-session-cache');
        if (cachedSession) {
          try {
            const parsed = JSON.parse(cachedSession);
            if (parsed && parsed.user && typeof parsed.role_level === 'number') {
              setLoggedIn(true);
              setAllowedPages(rolePages[parsed.role_level] || rolePages[4]);
              setLoading(false);
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
          return;
        }

        if (isMounted) {
          if (session) {
            setLoggedIn(true);
            localStorage.setItem('sb-session', JSON.stringify(session));

            const profile = await getCurrentProfile();
            const roleLevel = profile?.role_level ?? null;

            const businessAdmin = isBusinessAdmin(profile as UserProfile | null);
            let permissions = new Set<string>();
            if (roleLevel === null && !businessAdmin) {
              permissions = await getMyPermissions();
            }
            const pages = resolveAllowedPages(profile as UserProfile | null, permissions, rolePages);
            if (isMounted) setAllowedPages(pages);

            // Only cache a real (legacy) role_level number for the fast
            // path above -- caching `null` would need the permissions set
            // cached alongside it to be useful, which this deliberately
            // does not do (see the fast-path comment above).
            sessionStorage.setItem('sb-session-cache', JSON.stringify({
              user: session.user,
              ...(roleLevel !== null ? { role_level: roleLevel } : {})
            }));
          } else {
            setLoggedIn(false);
            localStorage.removeItem('sb-session');
            sessionStorage.removeItem('sb-session-cache');
          }
          setLoading(false);
        }
      } catch (err) {
        console.error('Session check failed:', err);
        setLoggedIn(false);
        setLoading(false);
      }
    };

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isMounted) return;
      
      if (event === 'SIGNED_IN' && session) {
        setLoggedIn(true);
        localStorage.setItem('sb-session', JSON.stringify(session));

        const profile = await getCurrentProfile();
        const roleLevel = profile?.role_level ?? null;

        const businessAdmin = isBusinessAdmin(profile as UserProfile | null);
        let permissions = new Set<string>();
        if (roleLevel === null && !businessAdmin) {
          permissions = await getMyPermissions();
        }
        if (isMounted) {
          setAllowedPages(resolveAllowedPages(profile as UserProfile | null, permissions, rolePages));
        }

        sessionStorage.setItem('sb-session-cache', JSON.stringify({
          user: session.user,
          ...(roleLevel !== null ? { role_level: roleLevel } : {})
        }));
        setLoading(false);
      } else if (event === 'SIGNED_OUT') {
        setLoggedIn(false);
        setAllowedPages(rolePages[4]);
        localStorage.removeItem('sb-session');
        sessionStorage.removeItem('sb-session-cache');
        setLoading(false);
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
        
        const cachedSession = sessionStorage.getItem('sb-session-cache');
        if (cachedSession) {
          try {
            const parsed = JSON.parse(cachedSession);
            if (parsed && parsed.user && typeof parsed.role_level === 'number') {
              setLoggedIn(true);
              setAllowedPages(rolePages[parsed.role_level] || rolePages[4]);
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