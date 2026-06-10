import { Routes, Route } from 'react-router-dom';
import { Nav } from './components/Nav';
import { Dashboard } from './pages/Dashboard';
import { Import } from './pages/Import';
import { Categories } from './pages/Categories';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/import" element={<Import />} />
      <Route path="/categories" element={<Categories />} />
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
