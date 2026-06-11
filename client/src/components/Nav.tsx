import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/import', label: 'Import from Image' },
  { to: '/categories', label: 'Categories' },
  { to: '/payment-methods', label: 'Payment Methods' },
] as const;

export function Nav() {
  return (
    <aside className="w-56 bg-primary-950 flex flex-col flex-shrink-0 select-none">
      <div className="px-5 py-5 border-b border-primary-800/70">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center shadow-inner">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-tight">ExpenseTracker</div>
            <div className="text-primary-400 text-xs leading-tight">Personal Finance</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {links.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-800/60 text-white'
                  : 'text-primary-300 hover:bg-primary-800/40 hover:text-primary-100',
              ].join(' ')
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
