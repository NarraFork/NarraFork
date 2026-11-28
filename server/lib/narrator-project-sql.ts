export function narratorProjectIdSql(alias: string): string {
	return `coalesce(${alias}.context_project_id, (select npl.project_id from narrator_project_links npl where npl.narrator_id = ${alias}.id and npl.role = 'primary'))`;
}
