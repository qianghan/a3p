/**
 * Scholarship routes' entitlement guard — re-exports the shared Student
 * Success guard so all student plugins check "paid" identically (no drift).
 */
export {
  requireStudentAddon as requireScholarshipAccess,
  STUDENT_ADDON_CODE,
} from '@/lib/agentbook-student/guard';
