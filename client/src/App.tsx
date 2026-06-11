import { Routes, Route } from 'react-router-dom';
import { Nav } from './components/Nav';
import { Dashboard } from './pages/Dashboard';
import { Import } from './pages/Import';
import { Categories } from './pages/Categories';
import { PaymentMethods } from './pages/PaymentMethods';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/import" element={<Import />} />
      <Route path="/categories" element={<Categories />} />
      <Route path="/payment-methods" element={<PaymentMethods />} />
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
