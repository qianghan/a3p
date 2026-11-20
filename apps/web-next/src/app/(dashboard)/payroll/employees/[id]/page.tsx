'use client';

import { useParams } from 'next/navigation';
import EmployeeDetail from './employee-detail';

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <EmployeeDetail id={id} />;
}
