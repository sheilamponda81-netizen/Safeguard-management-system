import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { getSystemCurrentMonth, getMonthLabel, getAvailableMonthsFromSystem } from '../utils/currentMonth';

interface MonthSelectorProps {
  selectedMonth: string;
  onMonthChange: (month: string) => void;
  availableMonths?: string[];
  isLoading?: boolean;
}

export function MonthSelector({ 
  selectedMonth, 
  onMonthChange, 
  availableMonths: propMonths,
  isLoading 
}: MonthSelectorProps) {
  const [availableMonths, setAvailableMonths] = useState<string[]>(propMonths || []);
  const [systemMonth, setSystemMonth] = useState<string>('');

  useEffect(() => {
    const fetchSystemMonth = async () => {
      const month = await getSystemCurrentMonth();
      setSystemMonth(month);
    };
    fetchSystemMonth();
  }, []);

  useEffect(() => {
    if (!propMonths) {
      setAvailableMonths(getAvailableMonthsFromSystem());
    } else {
      setAvailableMonths(propMonths);
    }
  }, [propMonths]);

  const currentIndex = availableMonths.indexOf(selectedMonth);
  const canGoBack = currentIndex > 0;
  const canGoForward = currentIndex < availableMonths.length - 1;

  const goToPrevious = () => {
    if (canGoBack) {
      onMonthChange(availableMonths[currentIndex - 1]);
    }
  };

  const goToNext = () => {
    if (canGoForward) {
      onMonthChange(availableMonths[currentIndex + 1]);
    }
  };

  const goToCurrent = () => {
    if (systemMonth) {
      onMonthChange(systemMonth);
    }
  };

  const isCurrentMonth = selectedMonth === systemMonth;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={goToPrevious}
        disabled={!canGoBack || isLoading}
        className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Previous Month"
      >
        <ChevronLeft size={18} />
      </button>
      
      <div className="flex items-center gap-2 min-w-[140px] justify-center">
        <Calendar size={16} className="text-[#D4A017]" />
        <span className="text-sm font-medium text-slate-700">
          {getMonthLabel(selectedMonth)}
        </span>
        {!isCurrentMonth && (
          <button
            onClick={goToCurrent}
            className="text-xs text-[#D4A017] hover:underline ml-1"
          >
            (Current)
          </button>
        )}
      </div>
      
      <button
        onClick={goToNext}
        disabled={!canGoForward || isLoading}
        className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Next Month"
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}