import { useState, useEffect } from 'react';
import { Building2, ClipboardList, Car, Bot, Camera, Sparkles, Smartphone, Clock, TrendingUp, Phone, Mail } from 'lucide-react';
import { Card, Badge, PageHeader } from '../components/ui';
import { getCurrentProfile } from '../utils/currentProfile';
// ===== Import audit logger =====
import { logAudit } from '../utils/auditLogger';

export function FeaturesPage() {
  const [userProfile, setUserProfile] = useState<any>(null);

  // Fetch user profile for audit logging
  useEffect(() => {
    const fetchUserProfile = async () => {
      const profile = await getCurrentProfile();
      setUserProfile(profile);
    };
    fetchUserProfile();
  }, []);

  // ===== Audit log for viewing the Features page =====
  useEffect(() => {
    const logFeaturesView = async () => {
      if (userProfile) {
        await logAudit({
          action: 'VIEW',
          entity_type: 'features_page',
          new_data: {
            page: 'Future Features Roadmap',
            timestamp: new Date().toISOString(),
            user_role: userProfile?.role_level,
            is_super_admin: userProfile?.is_super_admin
          },
          region_id: userProfile?.region_id
        });
      }
    };

    logFeaturesView();
  }, [userProfile]);

  const features = [
    {
      title: 'AI-Powered Analytics',
      desc: 'Predictive insights for workforce management',
      icon: Bot,
      status: 'Requirements gathering — mapping which attendance and payroll signals to model first',
      value: 'Surfaces attrition risk and absenteeism patterns before they hit payroll costs, cutting the hours managers spend combing through reports every month.'
    },
    {
      title: 'Mobile App',
      desc: 'Employee self-service portal for attendance and payslips',
      icon: Smartphone,
      status: 'UI/UX wireframes in review',
      value: 'Lets guards clock in, check payslips, and request leave from their own phone — fewer walk-in HR requests and faster turnaround for the field team.'
    },
    {
      title: 'Biometric Integration',
      desc: 'Fingerprint and facial recognition for attendance',
      icon: Camera,
      status: 'Evaluating fingerprint and facial recognition hardware partners',
      value: "Closes the door on buddy-punching and disputed hours, giving an audit-proof attendance record that backs every client invoice."
    },
    {
      title: 'Fleet Management',
      desc: 'Track security vehicles and patrol routes',
      icon: Car,
      status: 'Requirements gathering with the operations team',
      value: 'Turns patrol routes into verifiable data — proof of coverage for client SLAs, plus fuel and maintenance costs tracked against actual usage.'
    },
    {
      title: 'Client Portal',
      desc: 'Real-time reporting for client companies',
      icon: Building2,
      status: 'Defining reporting requirements with pilot clients',
      value: "Gives client companies live visibility into their guards' shifts and incidents — fewer status-check calls to the office and a stronger case for contract renewal."
    },
    {
      title: 'Document Management',
      desc: 'Digital storage for employee contracts and certificates',
      icon: ClipboardList,
      status: 'Solution design and storage architecture in progress',
      value: 'Every contract and certification searchable in seconds — faster credential checks before deploying a guard, and audit-ready records when a labor inspection comes knocking.'
    }
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Future Features Roadmap"
        subtitle="Upcoming enhancements and planned features"
      />

      <Card className="relative overflow-hidden p-6 md:p-8 bg-gradient-to-br from-[#F8FAFC] to-[#FFF9E5] border border-slate-200">
        <div className="relative flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-[#081C3A] flex items-center justify-center shadow-md flex-shrink-0">
            <Sparkles size={28} className="text-[#D4A017]" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-[#081C3A] mb-2">Scaling to 1,000+ Employees</h2>
            <p className="text-slate-600 max-w-2xl leading-relaxed">
              Safeguard already runs full HR, payroll, attendance, and recruitment operations for
              security teams across every region in Malawi. The six initiatives below are the next
              layer on top of that foundation — each one scoped, prioritized, and ready to build.
            </p>
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <Badge color="gold">Target: Q1 2026</Badge>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-[#DBEAFE] text-[#1E40AF]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
                Actively in development
              </span>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <div key={i} className="animate-fade-in-stagger" style={{ animationDelay: `${i * 70}ms` }}>
              <Card className="group relative overflow-hidden p-6 h-full border border-slate-200 hover:border-[#D4A017]/40 hover:shadow-xl hover:-translate-y-1 transition-all duration-300">
                <span className="absolute top-3 right-4 text-4xl font-black text-slate-100 group-hover:text-[#FFF3D6] transition-colors duration-300 select-none">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="relative flex flex-col h-full">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#081C3A] to-[#122a52] flex items-center justify-center text-[#D4A017] mb-4 group-hover:scale-110 transition-transform duration-300">
                    <Icon size={22} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800 mb-1">{f.title}</h3>
                  <p className="text-sm text-slate-600 mb-4 leading-relaxed">{f.desc}</p>

                  <div className="flex items-start gap-2 text-xs text-slate-500 mb-3">
                    <Clock size={13} className="text-slate-400 flex-shrink-0 mt-0.5" />
                    <span><strong className="text-slate-700 font-semibold">Right now:</strong> {f.status}</span>
                  </div>

                  <div className="mt-auto p-3 rounded-lg bg-[#FFF9E5] border border-[#FFF1CC]">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#8B6F0F] mb-1">
                      <TrendingUp size={13} /> Business Value
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{f.value}</p>
                  </div>

                  <div className="mt-4">
                    <Badge color="gold">Coming Soon</Badge>
                  </div>
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      <Card className="p-6 bg-[#081C3A] text-white border-0">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold">Want to move one of these forward?</h3>
            <p className="text-white/70 text-sm mt-1">
              Every feature above is scoped and ready to build — get in touch to discuss timelines and pricing.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <a href="tel:0996791776" className="flex items-center gap-2 hover:text-[#D4A017] transition-colors">
              <Phone size={15} className="text-[#D4A017]" /> 0996791776
            </a>
            <a href="mailto:razaquemponda831@gmail.com" className="flex items-center gap-2 hover:text-[#D4A017] transition-colors">
              <Mail size={15} className="text-[#D4A017]" /> razaquemponda831@gmail.com
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default FeaturesPage;
