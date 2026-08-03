// src/pages/UserManual.tsx
import { useState } from 'react';
import { 
  BookOpen, LayoutDashboard, Users, UserCheck, Calendar, Wallet, 
  FileText, CreditCard, Calculator, FileBarChart, Settings, 
  Shield, ShieldCheck, History, User, Building2, MapPin, 
  ChevronDown, ChevronRight, CheckCircle, AlertCircle, 
  Smartphone, Briefcase, Award, Sparkles, Mail, Phone, 
  Star, Heart, Zap, Crown, Lock, Server, Database, Cloud, 
  Fingerprint, Key
} from '../utils/icons';
import { Card, Button, Badge, PageHeader } from '../components/ui';

// ===== HELPERS =====
const SectionTitle = ({ children, icon: Icon }: { children: React.ReactNode; icon?: any }) => (
  <div className="flex items-center gap-3 mb-4">
    {Icon && <div className="w-10 h-10 rounded-xl bg-[#D4A017]/10 text-[#D4A017] flex items-center justify-center"><Icon size={22} /></div>}
    <h2 className="text-xl font-bold text-slate-800">{children}</h2>
  </div>
);

const FeatureCard = ({ icon: Icon, title, description, color = 'navy' }: any) => {
  const colorMap: Record<string, string> = {
    navy: 'bg-[#081C3A] text-white',
    gold: 'bg-[#D4A017] text-white',
    green: 'bg-emerald-500 text-white',
    blue: 'bg-blue-500 text-white',
    purple: 'bg-purple-500 text-white',
    red: 'bg-red-500 text-white'
  };
  return (
    <div className="p-5 rounded-xl border border-slate-200 hover:shadow-xl hover:scale-[1.02] transition-all duration-300 group">
      <div className={`w-12 h-12 rounded-xl ${colorMap[color]} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300`}>
        <Icon size={22} />
      </div>
      <h4 className="font-semibold text-slate-800 mb-2">{title}</h4>
      <p className="text-sm text-slate-600">{description}</p>
    </div>
  );
};

const RoleCard = ({ title, level, description, permissions, color = 'navy' }: any) => {
  const colorMap: Record<string, string> = {
    navy: 'border-[#081C3A]/20 bg-[#081C3A]/5 hover:border-[#081C3A]/40',
    gold: 'border-[#D4A017]/20 bg-[#D4A017]/5 hover:border-[#D4A017]/40',
    green: 'border-emerald-500/20 bg-emerald-500/5 hover:border-emerald-500/40',
    blue: 'border-blue-500/20 bg-blue-500/5 hover:border-blue-500/40',
    purple: 'border-purple-500/20 bg-purple-500/5 hover:border-purple-500/40'
  };
  return (
    <div className={`p-5 rounded-xl border ${colorMap[color]} transition-all duration-300 hover:shadow-lg hover:scale-[1.02]`}>
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-bold text-slate-800">{title}</h4>
        <Badge color={color}>{level}</Badge>
      </div>
      <p className="text-sm text-slate-600 mb-3">{description}</p>
      <div className="space-y-1.5">
        {permissions.map((p: string, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
            <CheckCircle size={12} className="text-emerald-500 flex-shrink-0" />
            <span>{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export function UserManualPage() {
  const sections = [
    { id: 'getting-started', label: 'Getting Started' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'employees', label: 'Employees' },
    { id: 'recruitment', label: 'Recruitment' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'payroll', label: 'Payroll & Payslips' },
    { id: 'payments', label: 'Payments & Terminal Dues' },
    { id: 'security', label: 'Security Personnel' },
    { id: 'reports', label: 'Reports' },
    { id: 'settings', label: 'Settings & Audit Logs' },
    { id: 'roles', label: 'Roles & Permissions' },
    { id: 'about', label: 'About & Contact' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="📖 User Manual"
        subtitle="Complete guide to the Safeguard HR & Payroll System"
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            <BookOpen size={16} className="mr-1" /> Print Manual
          </Button>
        }
      />

      {/* Hero Banner */}
      <Card className="p-8 bg-gradient-to-br from-[#F8FAFC] to-[#FFF9E5] border border-slate-200 shadow-sm hover:shadow-md transition-all duration-500">
        <div className="max-w-4xl">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-2xl bg-[#081C3A] flex items-center justify-center text-3xl shadow-lg">
              <Shield size={32} className="text-[#D4A017]" />
            </div>
            <div>
              <h1 className="text-2xl md:text-4xl font-bold text-[#081C3A]">Safeguard HR & Payroll System</h1>
              <p className="text-slate-500 text-sm md:text-base">Version 2.0 · Enterprise Security Management Platform</p>
            </div>
          </div>
          <p className="text-slate-600 text-sm md:text-base leading-relaxed max-w-3xl">
            Welcome to the Safeguard HR & Payroll System. This comprehensive platform is designed
            to streamline human resources, payroll processing, attendance tracking, and security
            personnel management for modern security companies. Built with cutting-edge technology
            to ensure efficiency, accuracy, and scalability.
          </p>
          <div className="flex gap-2 mt-4 flex-wrap">
            <Badge color="gold">HR Management</Badge>
            <Badge color="green">Payroll Processing</Badge>
            <Badge color="blue">Attendance Tracking</Badge>
            <Badge color="navy">Security Personnel</Badge>
          </div>
        </div>
      </Card>

      {/* Quick Navigation */}
      <Card className="p-5 hover:shadow-lg transition-all duration-300">
        <h3 className="font-semibold text-slate-800 mb-4">📚 Quick Navigation</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                const el = document.getElementById(s.id);
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-[#D4A017]/10 hover:text-[#081C3A] transition-all duration-200 hover:translate-x-1"
            >
              • {s.label}
            </button>
          ))}
        </div>
      </Card>

      {/* ===== GETTING STARTED ===== */}
      <div id="getting-started" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Sparkles}>Getting Started</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold text-slate-800 mb-3">System Overview</h4>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Safeguard HR & Payroll System is a comprehensive management platform designed 
                specifically for security companies operating across multiple regions in Malawi. 
                It handles everything from employee onboarding to payroll processing, attendance 
                tracking, and security personnel management.
              </p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" />
                  <span>Multi-region support (South, Central, North, East)</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" />
                  <span>Role-based access control (Admin, Manager, Supervisor, Staff)</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" />
                  <span>Real-time payroll and attendance tracking</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" />
                  <span>Audit logs for complete accountability</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3">Quick Start Guide</h4>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</div>
                  <div><strong>Login</strong> — Use your registered email and password to access the system</div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</div>
                  <div><strong>Navigate</strong> — Use the sidebar to access different modules</div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</div>
                  <div><strong>Manage</strong> — Add employees, process payroll, track attendance</div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#D4A017] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">4</div>
                  <div><strong>Monitor</strong> — Use reports and audit logs to ensure compliance</div>
                </div>
              </div>
              <div className="mt-4 p-3 bg-[#E8EDF5] rounded-lg text-xs text-slate-600">
                <strong>💡 Tip:</strong> Hover over any menu item to preload the page for faster navigation.
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== DASHBOARD ===== */}
      <div id="dashboard" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={LayoutDashboard}>Dashboard</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Dashboard provides a real-time overview of your entire organization. It displays 
                key metrics and trends to help you make informed decisions quickly.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Employee Stats</strong> — Total employees, active guards, supervisors on duty</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Payroll Overview</strong> — Monthly payroll trends and totals</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Attendance Rate</strong> — Real-time attendance tracking</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-purple-500 flex-shrink-0" />
                  <span><strong>Department Distribution</strong> — Employee breakdown by department</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-emerald-700">📊</p>
                <p className="text-xs text-emerald-700 font-medium">Real-time Metrics</p>
              </div>
              <div className="p-4 rounded-xl bg-[#FFF9E5] border border-[#D4A017]/30 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-[#D4A017]">📈</p>
                <p className="text-xs text-[#D4A017] font-medium">Trend Analysis</p>
              </div>
              <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-blue-600">👥</p>
                <p className="text-xs text-blue-600 font-medium">Workforce Overview</p>
              </div>
              <div className="p-4 rounded-xl bg-purple-50 border border-purple-200 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-purple-600">📍</p>
                <p className="text-xs text-purple-600 font-medium">Site Coverage</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== EMPLOYEES ===== */}
      <div id="employees" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Users}>Employees</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Employee Management module is the heart of the system. It allows you to 
                manage all employee records, including personal information, employment details, 
                compensation, and next-of-kin information.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Add/Edit Employees</strong> — Complete employee profiles with all required details</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Company & Workstation</strong> — Assign employees to specific sites and companies</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Uniform Deduction</strong> — Set monthly uniform deductions (default: MK 10,000)</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span><strong>Delete & Restore</strong> — Soft delete employees with restore capability</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Employee Fields Explained</h4>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Employee Number</span>
                  <span className="font-medium">Auto-generated (e.g., C001, S002, N003)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Uniform Deduction</span>
                  <span className="font-medium">Default: MK 10,000 (adjustable)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Company/Workstation</span>
                  <span className="font-medium">UPPERCASE auto-formatting</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Region</span>
                  <span className="font-medium">South, Central, North, East</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-slate-500">Next of Kin</span>
                  <span className="font-medium">Emergency contact details</span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== RECRUITMENT ===== */}
      <div id="recruitment" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={UserCheck}>Recruitment</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Recruitment pipeline helps you track applicants through the hiring process 
                from application to hiring decision. Each applicant can be shortlisted, interviewed, 
                accepted, or rejected.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Pipeline Status</strong> — Pending → Shortlisted → Interviewed → Accepted/Rejected</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Applicant Details</strong> — Full profile including qualifications and experience</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <span><strong>Quick Actions</strong> — One-click status updates</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-center">
              <div className="grid grid-cols-3 gap-3 w-full">
                <div className="p-4 rounded-xl bg-blue-50 text-center hover:scale-105 transition-all duration-300 cursor-default">
                  <p className="text-2xl font-bold text-blue-600">📋</p>
                  <p className="text-xs text-blue-600 font-medium">Pending</p>
                </div>
                <div className="p-4 rounded-xl bg-[#FFF9E5] text-center hover:scale-105 transition-all duration-300 cursor-default">
                  <p className="text-2xl font-bold text-[#D4A017]">⭐</p>
                  <p className="text-xs text-[#D4A017] font-medium">Shortlisted</p>
                </div>
                <div className="p-4 rounded-xl bg-emerald-50 text-center hover:scale-105 transition-all duration-300 cursor-default">
                  <p className="text-2xl font-bold text-emerald-600">✅</p>
                  <p className="text-xs text-emerald-600 font-medium">Accepted</p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== ATTENDANCE ===== */}
      <div id="attendance" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Calendar}>Attendance</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Attendance module allows you to track employee attendance on a daily basis. 
                Each employee's status can be toggled through Present, Absent, Late, Leave, and Sick.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Status Cycle</strong> — P→A→L→LV→SL→- (click to cycle through)</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Deductions</strong> — Automatic calculation: MK 4,200 per absent/late day</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span><strong>Lecture/Appearance</strong> — Additional deductions for missed lectures</span>
                </div>
              </div>
              <div className="mt-4 p-3 bg-[#E8EDF5] rounded-lg text-xs text-slate-600">
                <strong>⚡ Performance:</strong> Status updates are instant with optimistic UI for smooth experience.
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Status Colors</h4>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-emerald-500" /> Present (P)</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-red-500" /> Absent (A) → MK 4,200</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-yellow-400" /> Late (L) → MK 4,200</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-blue-500" /> Leave (LV)</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-purple-500" /> Sick (SL)</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 rounded bg-slate-200" /> Off/Weekend (-)</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== PAYROLL ===== */}
      <div id="payroll" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Wallet}>Payroll & Payslips</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Payroll module handles salary calculations, deductions, and payslip generation. 
                It processes payroll for the current month and requires manager/admin approval.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Calculations</strong> — Basic + Allowances (0%) + Overtime (0%) + Bonus</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span><strong>Deductions</strong> — PAYE (30%) + Pension (5%) + Uniform + Attendance</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Approval Workflow</strong> — Process → Pending Approval → Approved</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Payslips</strong> — Download PDF, print, or bulk download as ZIP</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Payroll Formula</h4>
              <div className="space-y-2 text-xs">
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <p className="font-medium text-slate-700">Gross Pay</p>
                  <p className="text-slate-600">= Basic Salary + Allowances + Overtime + Bonus</p>
                </div>
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <p className="font-medium text-slate-700">Net Pay</p>
                  <p className="text-slate-600">= Gross Pay - PAYE - Pension - Uniform - Attendance</p>
                </div>
                <div className="p-3 bg-red-50 rounded-lg border border-red-200 text-xs text-red-600">
                  <AlertCircle size={14} className="inline mr-1" />
                  <strong>Default:</strong> Uniform Deduction = MK 10,000 · Absent/Late = MK 4,200/day
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== PAYMENTS & TERMINAL DUES ===== */}
      <div id="payments" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={CreditCard}>Payments & Terminal Dues</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Payments module manages salary disbursement statuses, while Terminal Dues 
                calculates employee termination benefits including gratuity, annual leave, and refunds.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Payment Status</strong> — Pending → Processing → Paid → Confirmed</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Terminal Dues</strong> — Calculate gratuity, annual leave, uniform refund</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span><strong>Status Flow</strong> — Pending → Approved → Paid</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Terminal Dues Breakdown</h4>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Gratuity</span>
                  <span className="font-medium">(Period × Basic × 10%)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Annual Leave</span>
                  <span className="font-medium">(26 Days × Basic ÷ 26)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Uniform Refund</span>
                  <span className="font-medium">Original uniform deduction amount</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-slate-500">Total Payable</span>
                  <span className="font-medium">Subtotal - Deductions</span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== SECURITY PERSONNEL ===== */}
      <div id="security" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Shield}>Security Personnel</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Security Personnel module manages guards, supervisors, uniforms, and deployments. 
                It provides a complete view of security staff across all sites and shifts.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Guard ID</strong> — Auto-generated (G-XXXX) for easy identification</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>Supervisor Search</strong> — Smart dropdown with search functionality</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Uniform Management</strong> — Track uniform status, condition, and shoes</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-purple-500 flex-shrink-0" />
                  <span><strong>Shift Management</strong> — Morning, Afternoon, Night, 24hr Rotation</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Guard Details</h4>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Guard ID</span>
                  <span className="font-mono font-medium">G-1234</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Shift</span>
                  <span className="font-medium">Morning (06-14) · Afternoon (14-22) · Night (22-06)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500">Supervisor</span>
                  <span className="font-medium">Searchable dropdown from employees</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-slate-500">Emergency Contact</span>
                  <span className="font-medium">Next of kin details</span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== REPORTS ===== */}
      <div id="reports" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={FileBarChart}>Reports</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Reports module provides comprehensive analytics and insights across all 
                system data. Generate reports on employees, payroll, attendance, recruitment, 
                departments, companies, and workstations.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Export Options</strong> — CSV format for all reports</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>7 Report Types</strong> — Employee, Company, Workstation, Payroll, Attendance, Recruitment, Department</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Summary Stats</strong> — Total employees, payroll, sites, and more</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-emerald-50 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-emerald-700">📊</p>
                <p className="text-xs text-emerald-700 font-medium">7 Report Types</p>
              </div>
              <div className="p-4 rounded-xl bg-[#FFF9E5] text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-[#D4A017]">📥</p>
                <p className="text-xs text-[#D4A017] font-medium">CSV Export</p>
              </div>
              <div className="p-4 rounded-xl bg-blue-50 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-blue-600">📈</p>
                <p className="text-xs text-blue-600 font-medium">Analytics</p>
              </div>
              <div className="p-4 rounded-xl bg-purple-50 text-center hover:scale-105 transition-all duration-300 cursor-default">
                <p className="text-2xl font-bold text-purple-600">🏢</p>
                <p className="text-xs text-purple-600 font-medium">Company/Workstation</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== SETTINGS ===== */}
      <div id="settings" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Settings}>Settings & Audit Logs</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-600 leading-relaxed">
                The Settings module allows administrators to configure company preferences, 
                manage user accounts, and track system activity through comprehensive audit logs.
              </p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span><strong>Company Settings</strong> — Company info, tax, pension, payroll configuration</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-[#D4A017] flex-shrink-0" />
                  <span><strong>User Management</strong> — Create and manage users with role-based access</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <span><strong>Audit Logs</strong> — Complete history of all system actions</span>
                </div>
                <div className="flex items-center gap-3 text-slate-600">
                  <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                  <span><strong>Month Settings</strong> — Set the current payroll month</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-5 hover:bg-slate-100 transition-all duration-300">
              <h4 className="font-semibold text-slate-800 mb-3 text-sm">Audit Logs Track</h4>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> User logins and logouts</div>
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> Employee creation, updates, deletion</div>
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> Payroll processing and approval</div>
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> Attendance status changes</div>
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> Payment status updates</div>
                <div className="flex items-center gap-2 text-slate-600"><CheckCircle size={12} className="text-emerald-500 flex-shrink-0" /> System setting changes</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div id="roles" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={ShieldCheck}>Roles & Permissions</SectionTitle>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            The system uses role-based access control with four distinct levels. Each role has 
            specific permissions to ensure data security and appropriate access.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <RoleCard
              title="Admin"
              level="Level 1"
              description="Full system access. Can manage all modules, users, and system settings."
              permissions={[
                'All modules access',
                'User management',
                'Payroll processing & approval',
                'System settings',
                'Audit logs viewing'
              ]}
              color="gold"
            />
            <RoleCard
              title="Manager"
              level="Level 2"
              description="Access to HR, recruitment, reports, and regional management."
              permissions={[
                'Employee management',
                'Recruitment pipeline',
                'Attendance viewing',
                'Payment management',
                'Terminal dues',
                'Reports'
              ]}
              color="blue"
            />
            <RoleCard
              title="Supervisor"
              level="Level 3"
              description="Access to attendance tracking and security personnel management."
              permissions={[
                'Dashboard viewing',
                'Attendance management',
                'Security personnel',
                'Basic reports'
              ]}
              color="green"
            />
            <RoleCard
              title="Staff"
              level="Level 4"
              description="Basic access to view payslips and personal information."
              permissions={[
                'Dashboard',
                'Payslips viewing',
                'Profile access'
              ]}
              color="purple"
            />
          </div>
        </Card>
      </div>

      {/* ===== REGION LEVELS ===== */}
      <div className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={MapPin}>Region Levels</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              { name: 'Southern Region', code: 'SOUTH', desc: 'Manages employees in the Southern region of Malawi', color: 'gold' },
              { name: 'Central Region', code: 'CENTRAL', desc: 'Manages employees in the Central region of Malawi', color: 'blue' },
              { name: 'Northern Region', code: 'NORTH', desc: 'Manages employees in the Northern region of Malawi', color: 'green' },
              { name: 'Eastern Region', code: 'EAST', desc: 'Manages employees in the Eastern region of Malawi', color: 'purple' }
            ].map((region) => (
              <div key={region.code} className="p-4 rounded-xl border border-slate-200/20 bg-slate-50/50 hover:shadow-md hover:scale-[1.02] transition-all duration-300">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-3 h-3 rounded-full bg-${region.color === 'gold' ? '[#D4A017]' : region.color === 'blue' ? 'blue-500' : region.color === 'green' ? 'emerald-500' : 'purple-500'}`} />
                  <span className="font-bold text-slate-800 text-sm">{region.name}</span>
                </div>
                <p className="text-xs text-slate-500">{region.desc}</p>
                <Badge color={region.color as any} className="mt-2 text-xs">{region.code}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ===== ABOUT & CONTACT ===== */}
      <div id="about" className="scroll-mt-20">
        <Card className="p-6 hover:shadow-lg transition-all duration-300">
          <SectionTitle icon={Award}>About Safeguard HR & Payroll System</SectionTitle>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <p className="text-slate-600 text-sm leading-relaxed">
                The Safeguard HR & Payroll System is a comprehensive enterprise solution built
                specifically for security companies in Malawi. It represents the cutting edge of
                technology-driven security management, combining traditional HR functions with
                modern digital efficiency.
              </p>
              <div className="mt-4 space-y-2 text-sm text-slate-600">
                <div className="flex items-center gap-3">
                  <Zap size={16} className="text-[#D4A017]" />
                  <span>Built with modern technology stack (React, TypeScript, Supabase)</span>
                </div>
                <div className="flex items-center gap-3">
                  <Sparkles size={16} className="text-[#D4A017]" />
                  <span>Designed for scalability and enterprise growth</span>
                </div>
                <div className="flex items-center gap-3">
                  <Shield size={16} className="text-[#D4A017]" />
                  <span>Secure, reliable, and fully auditable</span>
                </div>
              </div>

              {/* ===== SECURITY & PRIVACY SECTION ===== */}
              <div className="mt-6 pt-4 border-t border-slate-200">
                <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                  <Fingerprint size={18} className="text-[#D4A017]" />
                  Security & Privacy Protection
                </h4>
                <div className="space-y-2 text-xs text-slate-600">
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Data Encryption:</strong> All data is encrypted at rest and in transit using industry-standard TLS/SSL protocols.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Access Control:</strong> Role-based access ensures only authorized personnel can view sensitive information.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Audit Trail:</strong> Every action is logged, providing complete accountability and the ability to trace any activity.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Two-Factor Authentication:</strong> Optional 2FA adds an extra layer of security to protect accounts.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Data Isolation:</strong> Regional data isolation ensures employees only access data relevant to their region.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span><strong>Backup & Recovery:</strong> Automated daily backups with point-in-time recovery capabilities.</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#F8FAFC] rounded-xl p-6 border border-slate-200 hover:bg-[#F1F5F9] transition-all duration-300">
              <h4 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                <User size={18} className="text-[#D4A017]" />
                Built By
              </h4>
              <div className="space-y-4">
                <div>
                  <p className="text-lg font-bold text-slate-800">Razaque Mponda</p>
                  <p className="text-sm text-[#8B6F0F] font-medium">Full Stack Developer & System Architect</p>
                  <div className="mt-2 space-y-1 text-sm text-slate-600">
                    <div className="flex items-center gap-2">
                      <Smartphone size={14} className="text-[#D4A017]" />
                      <span>0996791776</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Mail size={14} className="text-[#D4A017]" />
                      <span>razaquemponda831@gmail.com</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin size={14} className="text-[#D4A017]" />
                      <span>Blantyre, Malawi</span>
                    </div>
                  </div>
                </div>
                <div className="pt-3 border-t border-slate-200">
                  <p className="text-xs text-slate-400">
                    <Heart size={12} className="inline mr-1 text-red-400" />
                    Building the future of security management in Malawi
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Vision Section */}
          <div className="mt-6 pt-6 border-t border-slate-200">
            <h4 className="font-bold text-slate-800 mb-3">Our Vision</h4>
            <p className="text-slate-600 text-sm leading-relaxed">
              We are committed to making Safeguard Security Services the most technology-driven
              security company in Malawi. By leveraging modern software solutions, we aim to
              revolutionize how security personnel are managed, paid, and deployed across the nation.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <div className="px-4 py-2 rounded-lg bg-[#FFF9E5] border border-[#FFF1CC] text-xs text-[#8B6F0F] flex items-center gap-2 hover:bg-[#FFF1CC] transition-all duration-300">
                <Star size={14} className="text-[#D4A017]" /> Technology-Driven
              </div>
              <div className="px-4 py-2 rounded-lg bg-[#FFF9E5] border border-[#FFF1CC] text-xs text-[#8B6F0F] flex items-center gap-2 hover:bg-[#FFF1CC] transition-all duration-300">
                <Users size={14} className="text-[#D4A017]" /> People-Centered
              </div>
              <div className="px-4 py-2 rounded-lg bg-[#FFF9E5] border border-[#FFF1CC] text-xs text-[#8B6F0F] flex items-center gap-2 hover:bg-[#FFF1CC] transition-all duration-300">
                <Crown size={14} className="text-[#D4A017]" /> Industry Leader
              </div>
              <div className="px-4 py-2 rounded-lg bg-[#FFF9E5] border border-[#FFF1CC] text-xs text-[#8B6F0F] flex items-center gap-2 hover:bg-[#FFF1CC] transition-all duration-300">
                <Award size={14} className="text-[#D4A017]" /> Excellence
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ===== TERMS, PRIVACY & CONDITIONS ===== */}
      <Card className="p-6 border-t-4 border-[#D4A017] hover:shadow-lg transition-all duration-300">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
              <Shield size={16} className="text-[#D4A017]" /> Terms & Conditions
            </h4>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="hover:text-slate-800 transition-colors">• All data entered is the property of Safeguard Security Services</li>
              <li className="hover:text-slate-800 transition-colors">• Users must maintain confidentiality of login credentials</li>
              <li className="hover:text-slate-800 transition-colors">• Any misuse of the system will result in immediate suspension</li>
              <li className="hover:text-slate-800 transition-colors">• System access is granted based on role and region</li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
              <Lock size={16} className="text-[#D4A017]" /> Privacy Policy
            </h4>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="hover:text-slate-800 transition-colors">• Personal data is collected solely for HR and payroll purposes</li>
              <li className="hover:text-slate-800 transition-colors">• Data is stored securely with encryption at rest and in transit</li>
              <li className="hover:text-slate-800 transition-colors">• Employee data is only accessible to authorized personnel</li>
              <li className="hover:text-slate-800 transition-colors">• Audit logs track all data access and modifications</li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
              <CheckCircle size={16} className="text-[#D4A017]" /> Conditions of Use
            </h4>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="hover:text-slate-800 transition-colors">• System is for authorized personnel only</li>
              <li className="hover:text-slate-800 transition-colors">• All payroll and HR actions are subject to audit</li>
              <li className="hover:text-slate-800 transition-colors">• Regional managers are responsible for their region's data</li>
              <li className="hover:text-slate-800 transition-colors">• System updates and maintenance will be communicated in advance</li>
            </ul>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-slate-200 text-center text-xs text-slate-400">
          <p>© {new Date().getFullYear()} Safeguard Security Services · Built with ❤️ by Razaque Mponda</p>
          <p className="mt-1">Version 2.0 · Enterprise Security Management Platform</p>
        </div>
      </Card>
    </div>
  );
}

export default UserManualPage;