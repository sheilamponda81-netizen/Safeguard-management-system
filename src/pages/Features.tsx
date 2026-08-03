import { useState, useEffect } from 'react';
import { Building2, ClipboardList, Car, Bot, Camera, Sparkles, Smartphone } from 'lucide-react';
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
    { title: 'AI-Powered Analytics', desc: 'Predictive insights for workforce management', icon: Bot },
    { title: 'Mobile App', desc: 'Employee self-service portal for attendance and payslips', icon: Smartphone },
    { title: 'Biometric Integration', desc: 'Fingerprint and facial recognition for attendance', icon: Camera },
    { title: 'Fleet Management', desc: 'Track security vehicles and patrol routes', icon: Car },
    { title: 'Client Portal', desc: 'Real-time reporting for client companies', icon: Building2 },
    { title: 'Document Management', desc: 'Digital storage for employee contracts and certificates', icon: ClipboardList }
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Future Features Roadmap"
        subtitle="Upcoming enhancements and planned features"
      />

      <Card className="relative overflow-hidden p-6 bg-gradient-to-br from-[#081C3A] to-[#122a52] text-white border-0">
        {/* Soft ambient glow behind the icon -- a quiet bit of depth rather
            than another loud gradient. */}
        <div className="pointer-events-none absolute -top-10 -left-10 w-40 h-40 rounded-full bg-[#D4A017]/20 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-[#D4A017] flex items-center justify-center shadow-lg shadow-[#D4A017]/20">
            <Sparkles size={28} className="text-[#081C3A]" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Scaling to 1,000+ Employees</h2>
            <p className="text-white/70">Enterprise-ready architecture for future growth</p>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Badge color="gold">Q1 2026</Badge>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-[#DBEAFE] text-[#1E40AF]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
                In Development
              </span>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <div key={i} className="animate-fade-in-stagger" style={{ animationDelay: `${i * 70}ms` }}>
              <Card className="group relative overflow-hidden p-6 border border-slate-200 hover:border-[#D4A017]/40 hover:shadow-xl hover:-translate-y-1 transition-all duration-300">
                <span className="absolute top-3 right-4 text-4xl font-black text-slate-100 group-hover:text-[#FFF3D6] transition-colors duration-300 select-none">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="relative">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#081C3A] to-[#122a52] flex items-center justify-center text-[#D4A017] mb-4 group-hover:scale-110 transition-transform duration-300">
                    <Icon size={22} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800 mb-2">{f.title}</h3>
                  <p className="text-sm text-slate-600 mb-4 leading-relaxed">{f.desc}</p>
                  <Badge color="gold">Coming Soon</Badge>
                </div>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default FeaturesPage;
