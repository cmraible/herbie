import {useId, useState} from 'react';
import Select from 'react-select';
import {matchSorter} from 'match-sorter';
import type {Repository} from '@herbie/contracts';

export function RepositorySelect({repositories, value, onChange, onRefresh, loading, disabled}: {
  repositories: Repository[];
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const options = query.trim()
    ? matchSorter(repositories, query.trim(), {keys: ['fullName']})
    : repositories;

  return <div className="repository-picker">
    <div className="repository-label">
      <label htmlFor={id}>Repository</label>
      <button type="button" className="repository-refresh" aria-label="Refresh" title="Refresh repositories" disabled={loading || disabled} onClick={onRefresh}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7v5h-5M4 17v-5h5"/>
          <path d="M6.1 6.1A8 8 0 0 1 19.5 9L20 12M4 12l.5 3A8 8 0 0 0 17.9 17.9"/>
        </svg>
      </button>
    </div>
    <Select<Repository>
      inputId={id}
      instanceId={id}
      autoFocus
      required
      unstyled
      classNamePrefix="repository-select"
      options={options}
      value={repositories.find(repo => repo.fullName === value) ?? null}
      getOptionLabel={repo => repo.fullName}
      getOptionValue={repo => repo.fullName}
      inputValue={query}
      onInputChange={setQuery}
      onChange={repo => { if (repo) onChange(repo.fullName); }}
      filterOption={null}
      isDisabled={disabled || loading}
      isLoading={loading}
      placeholder={loading ? 'Loading repositories…' : 'Search repositories…'}
      noOptionsMessage={() => query.trim() ? 'No matching repositories' : 'No repositories available'}
      maxMenuHeight={280}
      formatOptionLabel={repo => <span className="repository-name"><span>{repo.fullName.split('/')[0]} / </span><strong>{repo.fullName.split('/').slice(1).join('/')}</strong></span>}
    />
    <p className="repository-hint">Type to search by owner or repository name.</p>
  </div>;
}
