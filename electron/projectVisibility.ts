import type { ProjectRecord } from '../src/data/types.js';

export const filterVisibleProjects = (projects: ProjectRecord[]) => projects.filter((project) => !project.isClosed);
