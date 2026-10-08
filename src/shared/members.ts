/** Email-free identity contract for the internal passkey transition. */
export type MemberIdentity = {
  id: string;
  name: string;
  role: 'admin' | 'member';
  color: string;
};

export type MemberStatus = 'pending' | 'active' | 'suspended';
export type InternalMember = MemberIdentity & { status: MemberStatus };

/** Preparing a roster never activates a member or grants a session. */
export type EnrollmentRosterMember = MemberIdentity & { status: 'pending' | 'suspended' };
