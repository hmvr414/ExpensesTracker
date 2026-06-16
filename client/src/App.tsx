import { Routes, Route } from 'react-router-dom';
import { Nav } from './components/Nav';
import { Dashboard } from './pages/Dashboard';
import { Movements } from './pages/Movements';
import { Import } from './pages/Import';
import { Categories } from './pages/Categories';
import { PaymentMethods } from './pages/PaymentMethods';
import { GmailSettings } from './pages/GmailSettings';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/movements" element={<Movements />} />
      <Route path="/import" element={<Import />} />
      <Route path="/categories" element={<Categories />} />
      <Route path="/payment-methods" element={<PaymentMethods />} />
      <Route path="/settings/gmail" element={<GmailSettings />} />
    </Routes>
  );
}

export function App() {
  return (
    <div className="flex h-screen bg-neutral-50 dark:bg-neutral-900">
      <Nav />
      <AppRoutes />
    </div>
  );
}
