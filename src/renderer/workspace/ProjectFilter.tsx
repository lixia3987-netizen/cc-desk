import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Project } from '../../shared/types';
import './project-filter.css';

interface Props { projects: Project[]; value: string; onChange: (id: string) => void }

/** Select-only combobox: keep keyboard focus on the trigger while navigating options. */
export function ProjectFilter({ projects, value, onChange }: Props) {
  const id = useId(), root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [activeId, setActiveId] = useState(value);
  const options = [{ id: 'all', name: '全部项目', path: '' }, ...projects];
  const selected = options.find(option => option.id === value) ?? options[0];
  const activeIndex = Math.max(0, options.findIndex(option => option.id === activeId));
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    if (value !== 'all' && !projects.some(project => project.id === value)) onChange('all');
  }, [projects, value, onChange]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (open) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);

  const choose = (next: string) => { onChange(next); setOpen(false); };
  const keydown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const selectedIndex = options.indexOf(selected);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : !open ? selectedIndex : Math.min(options.length - 1, Math.max(0, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setActiveId(options[index].id); setOpen(true);
    } else if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); choose(options[activeIndex].id);
    } else if (open && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  };

  return <div className="project-filter" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button type="button" className="project-filter-trigger" role="combobox" aria-label="工作空间筛选"
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open ? optionId(activeIndex) : undefined} title={selected.path || selected.name}
      onKeyDown={keydown} onClick={() => { setActiveId(selected.id); setOpen(!open); }}>
      <span className="project-filter-text"><strong>{selected.name}</strong>{selected.path && <small>{selected.path}</small>}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div id={`${id}-list`} className="project-filter-options" role="listbox" aria-label="项目列表">
      {options.map((option, index) => <div key={option.id} id={optionId(index)} role="option"
        aria-selected={selected.id === option.id} aria-label={option.path ? `${option.name}，${option.path}` : option.name}
        className={`project-filter-option${index === activeIndex ? ' highlighted' : ''}`} title={option.path || option.name}
        data-project-option={option.id} onPointerMove={() => setActiveId(option.id)}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option.id)}>
        <span className="project-filter-text"><strong>{option.name}</strong>{option.path && <small>{option.path}</small>}</span>
        {selected.id === option.id && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>}
  </div>;
}
