export type ServiceResult<T> = {
	success: boolean;
	data?: T;
	error?: string;
};
