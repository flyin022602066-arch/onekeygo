<template>
  <div class="studio" v-if="drama">
    <header class="studio-topbar">
      <div class="studio-topbar-main">
        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回项目
        </button>
        <div class="studio-identity">
          <h1 class="studio-title">{{ drama.title }}</h1>
          <span class="studio-episode-chip">第 {{ episodeNumber }} 集</span>
          <div class="studio-meta-row">
            <span class="studio-meta-pill">{{ currentSubStageLabel }}</span>
            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/11</span>
            <span class="studio-meta-inline">{{ chars.length }} 角色 · {{ sbs.length }} 镜头</span>
          </div>
        </div>
      </div>

      <div class="studio-topbar-side">
        <div class="studio-actions">
          <button class="btn" @click="refresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            刷新
          </button>
          <button class="btn btn-primary" @click="panel = mergeUrl ? 'export' : ((sbs.length || hasExtractedAssets) ? 'production' : 'script')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {{ mergeUrl ? '查看成片' : ((sbs.length || hasExtractedAssets) ? '继续制作' : '开始制作') }}
          </button>
        </div>
        <label class="dubbing-switch studio-dubbing-switch" title="关闭后跳过音色分配和配音生成">
          <input
            type="checkbox"
            :checked="dubbingEnabled"
            @change="setDubbingEnabled($event.target.checked)"
          />
          <span class="dubbing-switch-copy">
            <strong>配音</strong>
            <span>{{ dubbingEnabled ? '已开启' : '已关闭' }}</span>
          </span>
        </label>
      </div>
    </header>

    <div class="studio-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar">
      <nav class="pipeline">
        <div
          v-for="section in sidebarSections"
          :key="section.id"
          class="pipe-section"
        >
          <div class="pipe-section-label">{{ section.label }}</div>
          <button
            v-for="item in section.items"
            :key="item.key"
            :class="['pipe-item pipe-item-sub', { active: activeSubStepKey === item.key, done: item.done }]"
            @click="goSubStep(item.key)"
          >
            <span class="pipe-icon" :class="item.done ? 'icon-done' : activeSubStepKey === item.key ? 'icon-active' : ''">
              <svg v-if="item.done" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <component v-else :is="item.icon" :size="11" />
            </span>
            <span class="pipe-copy">
              <span class="pipe-label">{{ item.label }}</span>
              <span v-if="item.desc" class="pipe-sub">{{ item.desc }}</span>
            </span>
          </button>
        </div>
      </nav>

      <!-- Bottom: Progress + Refresh -->
      <div class="sidebar-bottom">
        <div class="progress-wrap">
          <div class="progress-head">
            <span class="progress-label">制作进度</span>
            <span class="progress-val">{{ pipelineProgress }}/11</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: Math.min(100, pipelineProgress / 11 * 100) + '%' }"></div>
          </div>
        </div>
        <div class="sidebar-jumper" v-if="sidebarJumpSteps.length">
          <button
            v-for="step in sidebarJumpSteps"
            :key="step.key"
            :class="['sidebar-jump-dot', { active: activeSubStepKey === step.key, done: step.done }]"
            @click="goSubStep(step.key)"
            :title="step.label"
          ></button>
        </div>
        <button class="refresh-btn" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          刷新数据
        </button>
      </div>
    </aside>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main">
      <div v-if="activeSubSteps.length" class="stage-subnav">
        <button
          v-for="sub in activeSubSteps"
          :key="sub.key"
          :class="['stage-subnav-item', { active: activeSubStepKey === sub.key, done: sub.done }]"
          @click="goSubStep(sub.key)"
        >
          <span>{{ sub.label }}</span>
          <span v-if="sub.done" class="stage-subnav-dot"></span>
        </button>
      </div>

      <!-- ===== SCRIPT PANEL ===== -->
      <div v-if="panel === 'script'" class="content-panel">
        <!-- Step 0: Raw Content -->
        <div v-if="scriptStep === 0" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">01</span>
                <span class="step-name">原始内容</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="rawLen" class="char-count">{{ rawLen }} 字</span>
              <button class="btn btn-sm" @click="saveRaw(); toast.success('已保存')">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                保存
              </button>
            </div>
          </div>
          <textarea
            class="fill-textarea"
            v-model="localRaw"
            placeholder="粘贴小说原文、故事大纲或分镜描述..."
          />
        </div>

        <!-- Step 1: Rewrite -->
        <div v-else-if="scriptStep === 1" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">02</span>
                <span class="step-name">AI 改写</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="scriptLen" class="char-count">{{ scriptLen }} 字</span>
              <button v-if="rawContent" class="btn btn-sm" @click="skipRewrite">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                跳过改写
              </button>
              <button v-if="scriptContent" class="btn btn-sm" @click="doRewrite" :disabled="rn">
                <Loader2 v-if="rn && rt === 'script_rewriter'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                重新改写
              </button>
            </div>
          </div>

          <div v-if="!scriptContent && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
            </div>
            <div class="empty-title">AI 改写为格式化剧本</div>
            <div class="empty-desc">你可以先用 AI 把原始内容整理成格式化剧本，也可以跳过这一步，直接使用原始内容继续提取角色与场景。</div>
            <div class="step-empty-actions">
              <button class="btn btn-primary" @click="doRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                开始改写
              </button>
              <button class="btn" @click="skipRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                跳过改写
              </button>
            </div>
          </div>
          <div v-else-if="rn && rt === 'script_rewriter'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在改写剧本...</div>
          </div>
          <textarea v-else class="fill-textarea" v-model="localScript" placeholder="格式化剧本内容..." />
        </div>

        <!-- Step 2: Extract -->
        <div v-else-if="scriptStep === 2" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">03</span>
                <span class="step-name">提取角色与场景</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="hasExtractedAssets" class="char-count">{{ chars.length }} 角色 · {{ scenes.length }} 场景</span>
              <button v-if="hasExtractedAssets" class="btn btn-sm" @click="doExtract" :disabled="rn">
                <Loader2 v-if="rn && rt === 'extractor'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                重新提取
              </button>
            </div>
          </div>

          <div v-if="!hasExtractedAssets && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <div class="empty-title">从剧本提取角色与场景</div>
            <div class="empty-desc">AI 自动分析剧本，提取角色信息和场景列表，与项目已有数据智能去重合并</div>
            <button class="btn btn-primary" @click="doExtract">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              开始提取
            </button>
          </div>
          <div v-else-if="rn && rt === 'extractor'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在提取角色和场景...</div>
          </div>
          <div v-else class="extract-stage">
            <aside class="card extract-summary">
              <div class="extract-summary-kicker">Extraction Board</div>
              <div class="extract-summary-title">角色与场景结果</div>
              <div class="extract-summary-desc">从剧本里提取出的角色和场景已经入库。这里先确认命名、定位和描述是否可直接进入后续制作。</div>
              <div class="extract-summary-stats">
                <div class="extract-summary-stat">
                  <span>角色</span>
                  <strong>{{ chars.length }}</strong>
                </div>
                <div class="extract-summary-stat">
                  <span>场景</span>
                  <strong>{{ scenes.length }}</strong>
                </div>
              </div>
              <div class="extract-summary-note">如果角色描述过于简短，后续分配音色和生成形象时建议先补充人物特征。</div>
            </aside>

            <div class="card extract-card">
              <div class="extract-card-head">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span>角色</span>
                <span class="tag tag-accent">{{ chars.length }}</span>
              </div>
              <div class="extract-list">
                <div v-for="c in chars" :key="c.id" class="extract-row">
                  <div class="char-avatar">{{ c.name?.[0] || '?' }}</div>
                  <div class="extract-info">
                    <div class="extract-name-row">
                      <div class="extract-name">{{ c.name }}</div>
                      <span class="tag">{{ c.role || '角色' }}</span>
                    </div>
                    <div class="extract-meta wrap">{{ c.description || c.appearance || c.personality || '暂无描述' }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card extract-card" v-if="scenes.length">
              <div class="extract-card-head">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                <span>场景</span>
                <span class="tag tag-accent">{{ scenes.length }}</span>
              </div>
              <div class="extract-list">
                <div v-for="s in scenes" :key="s.id" class="extract-row">
                  <div class="scene-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <div class="extract-info">
                    <div class="extract-name-row">
                      <div class="extract-name">{{ s.location }}</div>
                      <span v-if="s.time" class="tag">{{ s.time }}</span>
                    </div>
                    <div class="extract-meta wrap">{{ s.description || s.time || '等待补充场景描述' }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 3: Voice Assignment -->
          <div v-else-if="scriptStep === 3 && dubbingEnabled" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">04</span>
                <span class="step-name">分配音色</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="charsVoiced" class="char-count">{{ charsVoiced }}/{{ chars.length }} 已分配</span>
              <span v-if="voiceSampleCount" class="char-count">{{ voiceSampleCount }}/{{ charsVoiced }} 试听文件</span>
              <button v-if="charsVoiced" class="btn btn-sm" @click="doVoice" :disabled="rn">
                <Loader2 v-if="rn && rt === 'voice_assigner'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                重新分配
              </button>
              <button v-if="charsVoiced" class="btn btn-sm" @click="batchGenSamples">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19 5v14"/></svg>
                生成试听文件
              </button>
            </div>
          </div>

          <div v-if="!charsVoiced && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
            </div>
            <div class="empty-title">为角色分配合适的音色</div>
            <div class="empty-desc">AI 根据角色特征自动分配最匹配的 TTS 音色</div>
            <button class="btn btn-primary" @click="doVoice">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              AI 自动分配
            </button>
          </div>
          <div v-else-if="rn && rt === 'voice_assigner'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在分配音色...</div>
          </div>
          <div v-else class="voice-stage">
            <aside class="card voice-stage-panel">
              <div class="voice-stage-kicker">Voice Casting</div>
              <div class="voice-stage-title">角色声音分配台</div>
              <div class="voice-stage-desc">先为每个角色选择合适音色，再生成试听。音色标签会帮助你快速区分旁白、主角、反派和配角的表达方向。</div>
              <div class="voice-stage-stats">
                <div class="voice-stage-stat">
                  <span class="voice-stage-stat-label">已分配</span>
                  <strong>{{ charsVoiced }}/{{ chars.length }}</strong>
                </div>
                <div class="voice-stage-stat">
                  <span class="voice-stage-stat-label">试听文件</span>
                  <strong>{{ voiceSampleCount }}/{{ charsVoiced }}</strong>
                </div>
              </div>
              <div class="voice-library-meta">
                <span>音色库</span>
                <span>{{ voiceProfiles.length }} 条</span>
              </div>
              <div class="voice-library">
                <div v-for="voice in voiceProfiles" :key="voice.id" class="voice-library-item">
                  <div class="voice-library-head">
                    <span class="voice-library-name">{{ voice.label }}</span>
                    <span class="tag">{{ voice.gender }}</span>
                  </div>
                  <div class="voice-library-traits">{{ voice.traits }}</div>
                  <div class="voice-library-fit">{{ voice.suitable }}</div>
                </div>
              </div>
            </aside>

            <div class="voice-grid">
              <div v-for="c in chars" :key="c.id" class="card voice-card">
                <div class="voice-card-head">
                  <div class="voice-char">
                    <div class="char-avatar lg">{{ c.name?.[0] || '?' }}</div>
                    <div class="voice-name">
                      <div class="voice-name-row">
                        <div class="extract-name">{{ c.name }}</div>
                        <span class="tag" :class="(c.voice_style || c.voiceStyle) ? 'tag-success' : ''">{{ (c.voice_style || c.voiceStyle) ? '已分配' : '待分配' }}</span>
                      </div>
                      <div class="extract-meta">{{ c.role || '角色' }}</div>
                    </div>
                  </div>
                </div>

                <div class="voice-card-copy">
                  <div class="voice-card-text">{{ c.description || c.personality || c.appearance || '暂无角色描述，可根据人物定位手动挑选音色。' }}</div>
                </div>

                <div class="voice-select-block">
                  <span class="voice-block-label">选择音色</span>
                  <BaseSelect
                    :model-value="c.voice_style || c.voiceStyle || ''"
                    :options="voiceSelectOptions"
                    placeholder="选择音色"
                    searchable
                    style="width:100%"
                    @update:model-value="updateCharVoice(c.id, $event)"
                  />
                </div>

                <div v-if="getVoiceProfile(c.voice_style || c.voiceStyle)" class="voice-profile-card">
                  <div class="voice-profile-head">
                    <span class="voice-profile-name">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.label }}</span>
                    <span class="tag">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.gender }}</span>
                  </div>
                  <div class="voice-profile-traits">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.traits }}</div>
                  <div class="voice-profile-fit">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.suitable }}</div>
                </div>

                <div class="voice-actions-row">
                  <button class="btn btn-sm" :disabled="!(c.voice_style || c.voiceStyle)" @click="genSample(c.id)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    {{ (c.voice_sample_url || c.voiceSampleUrl) ? '重新试听' : '生成试听' }}
                  </button>
                  <span class="dim" style="font-size:11px">{{ (c.voice_sample_url || c.voiceSampleUrl) ? '已生成声音样本，可直接播放' : '生成后可快速确认角色声音' }}</span>
                </div>

                <div v-if="c.voice_sample_url || c.voiceSampleUrl" class="voice-player">
                  <audio :src="'/' + (c.voice_sample_url || c.voiceSampleUrl)" controls preload="none" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 4: Storyboard -->
        <div v-else-if="scriptStep === 4 || (scriptStep === 3 && !dubbingEnabled)" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">05</span>
                <span class="step-name">分镜列表</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="sbs.length" class="char-count">{{ sbs.length }} 镜头 · {{ totalDuration }}s</span>
              <button v-if="sbs.length" class="btn btn-sm" @click="addShot">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                添加
              </button>
              <template v-if="!sbs.length">
                <div class="storyboard-config-pills">
                  <span class="locked-config">拆解调用 · {{ storyboardAgentRuntimeLabel }}</span>
                  <span class="locked-config locked-config-subtle">视频规则参考 · {{ effectiveVideoConfigLabel }}</span>
                </div>
              </template>
              <div class="breakdown-mode" role="group" aria-label="分镜拆解模式">
                <button
                  v-for="option in storyboardBreakdownModeOptions"
                  :key="option.value"
                  type="button"
                  :class="['breakdown-mode-option', { active: storyboardBreakdownMode === option.value }]"
                  @click="selectStoryboardBreakdownMode(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
              <button class="btn btn-sm" :disabled="rn" @click="doBreakdown">
                <Loader2 v-if="rt === 'storyboard_breaker'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ sbs.length ? '重新拆解' : 'AI 拆解分镜' }}
              </button>
            </div>
          </div>

          <div v-if="sbs.length" class="split-layout">
            <!-- Shot List -->
            <div class="shot-list">
              <div class="shot-list-head">
                <div>
                  <div class="shot-list-title">镜头序列</div>
                  <div class="shot-list-sub">按镜头顺序检查内容与素材状态</div>
                </div>
                <span class="tag mono">{{ totalDuration }}s</span>
              </div>
              <div class="shot-list-body">
                <div
                  v-for="(sb, i) in sbs"
                  :key="sb.id"
                  :class="['shot-item', { active: selectedSb?.id === sb.id }]"
                  @click="selectedSb = sb"
                >
                  <div class="shot-item-header">
                    <div class="shot-num">#{{ String(i+1).padStart(2,'0') }}</div>
                    <span class="tag" style="font-size:10px">{{ sb.shot_type || sb.shotType || '—' }}</span>
                    <span v-if="getStoryboardCharacterIds(sb).length" class="tag" style="font-size:10px">{{ getStoryboardCharacterIds(sb).length }} 角色</span>
                    <div class="shot-status">
                      <div v-if="sb.imageUrl || sb.composedImage || sb.firstFrameImage" class="shot-dot has-img" title="已生成图片"></div>
                      <div v-if="sb.videoUrl || sb.composedVideoUrl" class="shot-dot has-video" title="已生成视频"></div>
                      <div v-if="sb.dialogue" class="shot-dot has-dialogue" title="有对白"></div>
                    </div>
                  </div>
                  <div class="shot-body">
                    <div class="shot-desc">{{ sb.description || sb.title || '无描述' }}</div>
                  </div>
                  <div class="shot-meta">
                    <span class="mono dim" style="font-size:10px">{{ sb.duration || 5 }}s</span>
                    <span v-if="sb.location" class="shot-location">{{ sb.location }}</span>
                    <span v-if="getStoryboardCharacterNames(sb).length" class="shot-location">{{ getStoryboardCharacterNames(sb).join(' / ') }}</span>
                    <span v-if="sb.dialogue" class="shot-dialogue">{{ sb.dialogue }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Detail Panel -->
            <div class="detail-panel" v-if="selectedSb">
                <div class="detail-head">
                  <div class="detail-head-copy">
                    <span class="detail-head-title">镜头 #{{ sbs.indexOf(selectedSb) + 1 }}</span>
                  <span class="detail-head-sub">{{ selectedSb.title || `镜头 ${sbs.indexOf(selectedSb) + 1}` }} · {{ selectedSb.shot_type || selectedSb.shotType || '未设置景别' }}</span>
                  </div>
                  <span class="tag mono">{{ (selectedSb.duration || 5) }}s</span>
                  <button class="btn btn-ghost btn-icon ml-auto" style="color:var(--error)" @click="deleteShot(selectedSb)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  </button>
              </div>
              <div class="detail-body">
                <div class="detail-hero">
                  <div class="detail-hero-copy">
                    <div class="detail-hero-label">镜头概览</div>
                    <div class="detail-hero-text">{{ selectedSb.description || selectedSb.title || '当前镜头还没有画面描述，建议先补充核心动作和构图。' }}</div>
                    <div class="detail-status-row">
                      <span class="tag">{{ getSceneName(selectedSb) }}</span>
                      <span class="tag">{{ selectedSb.angle || '未设角度' }}</span>
                      <span class="tag">{{ selectedSb.movement || '未设运镜' }}</span>
                      <span class="tag" :class="getFirstFrame(selectedSb) ? 'tag-success' : ''">首帧 {{ getFirstFrame(selectedSb) ? '已生成' : '待生成' }}</span>
                      <span class="tag" :class="getLastFrame(selectedSb) ? 'tag-success' : ''">尾帧 {{ getLastFrame(selectedSb) ? '已生成' : '待生成' }}</span>
                      <span class="tag" :class="hasVid(selectedSb) ? 'tag-success' : ''">视频 {{ hasVid(selectedSb) ? '已生成' : '待生成' }}</span>
                    </div>
                  </div>
                  <div class="detail-preview-grid">
                    <div class="detail-preview-card">
                      <div class="detail-preview-title">首帧</div>
                      <div class="detail-preview-media">
                        <img
                          v-if="getFirstFrame(selectedSb)"
                          :src="'/' + getFirstFrame(selectedSb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getFirstFrame(selectedSb), `镜头 #${sbs.indexOf(selectedSb) + 1} 首帧`)"
                        />
                        <div v-else class="detail-preview-empty">待生成</div>
                      </div>
                    </div>
                    <div class="detail-preview-card">
                      <div class="detail-preview-title">尾帧</div>
                      <div class="detail-preview-media">
                        <img
                          v-if="getLastFrame(selectedSb)"
                          :src="'/' + getLastFrame(selectedSb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getLastFrame(selectedSb), `镜头 #${sbs.indexOf(selectedSb) + 1} 尾帧`)"
                        />
                        <div v-else class="detail-preview-empty">待生成</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">镜头结构</span>
                    <span class="detail-section-copy">景别、角度、运镜、场景绑定和时长</span>
                  </div>
                  <div class="field-grid field-grid-4">
                    <label class="field">
                      <span class="field-label">标题</span>
                      <input :value="selectedSb.title || ''" class="input"
                        @blur="updateField(selectedSb, 'title', $event.target.value)" placeholder="如：雪地逼近" />
                    </label>
                    <label class="field">
                      <span class="field-label">景别</span>
                      <input
                        list="shot-type-list"
                        :value="selectedSb.shot_type || selectedSb.shotType || ''"
                        class="input"
                        placeholder="选择或输入景别"
                        @change="updateField(selectedSb, 'shot_type', $event.target.value)"
                      />
                      <datalist id="shot-type-list">
                        <option v-for="t in shotTypes" :key="t" :value="t" />
                      </datalist>
                    </label>
                    <label class="field">
                      <span class="field-label">角度</span>
                      <input
                        list="shot-angle-list"
                        :value="selectedSb.angle || ''"
                        class="input"
                        placeholder="选择或输入角度"
                        @change="updateField(selectedSb, 'angle', $event.target.value)"
                      />
                      <datalist id="shot-angle-list">
                        <option v-for="t in shotAngles" :key="t" :value="t" />
                      </datalist>
                    </label>
                    <label class="field">
                      <span class="field-label">运镜</span>
                      <input
                        list="shot-movement-list"
                        :value="selectedSb.movement || ''"
                        class="input"
                        placeholder="选择或输入运镜"
                        @change="updateField(selectedSb, 'movement', $event.target.value)"
                      />
                      <datalist id="shot-movement-list">
                        <option v-for="t in shotMovements" :key="t" :value="t" />
                      </datalist>
                    </label>
                  </div>
                  <div class="field-grid field-grid-4">
                    <label class="field">
                      <span class="field-label">绑定角色</span>
                      <div class="role-pills">
                        <button
                          v-for="char in chars"
                          :key="char.id"
                          type="button"
                          :class="['role-pill', { active: isStoryboardCharacterSelected(selectedSb, char.id) }]"
                          @click="toggleStoryboardCharacter(selectedSb, char.id)"
                        >
                          {{ char.name }}
                        </button>
                        <span v-if="!chars.length" class="dim" style="font-size:12px">当前集还没有角色</span>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">绑定场景</span>
                      <select class="input" :value="selectedSb.scene_id || selectedSb.sceneId || ''"
                        @change="updateField(selectedSb, 'scene_id', $event.target.value ? Number($event.target.value) : null)">
                        <option value="">未绑定场景</option>
                        <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
                          {{ scene.location }} · {{ scene.time || '未设时间' }}
                        </option>
                      </select>
                    </label>
                    <label class="field">
                      <span class="field-label">地点</span>
                      <input :value="selectedSb.location || ''" class="input"
                        @blur="updateField(selectedSb, 'location', $event.target.value)" placeholder="场景地点" />
                    </label>
                    <label class="field">
                      <span class="field-label">时间</span>
                      <input :value="selectedSb.time || ''" class="input"
                        @blur="updateField(selectedSb, 'time', $event.target.value)" placeholder="如：深夜 / 清晨" />
                    </label>
                    <label class="field">
                      <span class="field-label">时长</span>
                      <input :value="selectedSb.duration || 5" class="input" type="number" min="1" max="60"
                        @blur="updateField(selectedSb, 'duration', Number($event.target.value))" />
                    </label>
                  </div>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">画面语义</span>
                    <span class="detail-section-copy">动作、结果、氛围和对白</span>
                  </div>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">动作</span>
                      <textarea :value="selectedSb.action || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'action', $event.target.value)" placeholder="谁在做什么，表情和动作细节是什么" />
                    </label>
                    <label class="field">
                      <span class="field-label">结果</span>
                      <textarea :value="selectedSb.result || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'result', $event.target.value)" placeholder="镜头结束时的状态变化或画面结果" />
                    </label>
                  </div>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">画面描述</span>
                      <textarea :value="selectedSb.description || ''" class="textarea" rows="4"
                        @blur="updateField(selectedSb, 'description', $event.target.value)" placeholder="描述画面内容..." />
                    </label>
                    <label class="field">
                      <span class="field-label">氛围</span>
                      <textarea :value="selectedSb.atmosphere || ''" class="textarea" rows="4"
                        @blur="updateField(selectedSb, 'atmosphere', $event.target.value)" placeholder="光线、色调、空气感、环境氛围" />
                    </label>
                  </div>
                  <label class="field">
                    <span class="field-label">对白 / 旁白</span>
                    <textarea :value="selectedSb.dialogue || ''" class="textarea" rows="3"
                      @blur="updateField(selectedSb, 'dialogue', $event.target.value)" placeholder="角色名：台词内容 或 旁白：内容" />
                  </label>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">生成提示</span>
                    <span class="detail-section-copy">分别服务图片、视频、配乐和音效生成</span>
                  </div>
                  <label class="field">
                    <span class="field-label">静态画面提示词</span>
                    <textarea :value="selectedSb.image_prompt || selectedSb.imagePrompt || ''" class="textarea" rows="4"
                      @blur="updateField(selectedSb, 'image_prompt', $event.target.value)" placeholder="用于首帧、尾帧和镜头图片的单帧画面提示词" />
                  </label>
                  <label class="field">
                    <span class="field-label">视频提示词</span>
                    <textarea :value="selectedSb.video_prompt || selectedSb.videoPrompt || ''" class="textarea" rows="5"
                      @blur="updateField(selectedSb, 'video_prompt', $event.target.value)" placeholder="按 3 秒分段的视频提示词..." />
                  </label>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">配乐提示词</span>
                      <textarea :value="selectedSb.bgm_prompt || selectedSb.bgmPrompt || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'bgm_prompt', $event.target.value)" placeholder="如：压抑低频弦乐，缓慢推进" />
                    </label>
                    <label class="field">
                      <span class="field-label">音效提示词</span>
                      <textarea :value="selectedSb.sound_effect || selectedSb.soundEffect || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'sound_effect', $event.target.value)" placeholder="如：风雪声、脚踩积雪、衣料摩擦声" />
                    </label>
                  </div>
                </div>
              </div>
              <div v-if="agentErrorType === 'storyboard_breaker' && agentError" class="breakdown-error breakdown-error-inline" role="alert">
                <strong>重新拆解失败</strong>
                <span>{{ agentError }}</span>
              </div>
            </div>
          </div>

          <div v-else-if="rn && rt === 'storyboard_breaker'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在拆解分镜并生成提示词...</div>
            <div class="loading-detail">谜镜长文本拆解通常需要 1-3 分钟，请保持当前页面开启</div>
          </div>

          <div v-else class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/>
              </svg>
            </div>
            <div class="empty-title">将剧本拆解为分镜序列</div>
            <div class="empty-desc">AI 自动分析剧本，生成镜头列表和后续视频提示词</div>
            <div class="storyboard-config-stack">
              <div class="locked-config-banner">拆解调用：{{ storyboardAgentRuntimeLabel }}</div>
              <div class="locked-config-banner is-subtle">视频规则参考：{{ effectiveVideoConfigLabel }}</div>
            </div>
            <div class="breakdown-empty-config">
              <div class="breakdown-mode" role="group" aria-label="分镜拆解模式">
                <button
                  v-for="option in storyboardBreakdownModeOptions"
                  :key="option.value"
                  type="button"
                  :class="['breakdown-mode-option', { active: storyboardBreakdownMode === option.value }]"
                  @click="selectStoryboardBreakdownMode(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
              <div class="breakdown-hint">{{ storyboardBreakdownHint }}</div>
            </div>
            <div v-if="agentErrorType === 'storyboard_breaker' && agentError" class="breakdown-error" role="alert">
              <strong>拆解失败</strong>
              <span>{{ agentError }}</span>
            </div>
            <button class="btn btn-primary" @click="doBreakdown">
              <Loader2 v-if="rt === 'storyboard_breaker'" :size="13" class="animate-spin" />
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              AI 拆解分镜
            </button>
          </div>
        </div>

      </div>

      <!-- ===== PRODUCTION PANEL ===== -->
      <div v-else-if="panel === 'production'" class="content-panel">
        <!-- Guard: need script -->
        <div v-if="!scriptContent || (productionNeedsStoryboard && !sbs.length)" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="empty-title">尚未准备就绪</div>
          <div class="empty-desc">{{ !scriptContent ? '请先完成剧本编写' : '请先完成分镜拆解' }}</div>
          <button class="btn btn-primary" @click="panel = 'script'">前往剧本</button>
        </div>

        <template v-else>
          <div class="step-toolbar prod-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                <span class="step-name">制作工作台</span>
              </div>
            </div>
            <div class="prod-tabs">
              <button
                v-for="t in prodTabDefs"
                :key="t.id"
                :class="['prod-tab', { active: prodTab === t.id }]"
                @click="prodTab = t.id"
              >
                <component :is="t.icon" :size="11" />
                {{ t.label }}
                <span v-if="t.badge" class="prod-tab-badge">{{ t.badge }}</span>
              </button>
            </div>
          </div>

          <!-- Sub: Characters -->
          <div v-if="prodTab === 'chars'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ visualChars.length }} 个需生成角色设定稿</span>
              <span v-if="imageConfigSelectOptions.length <= 1" class="tag">{{ effectiveImageConfigLabel }}</span>
              <span v-if="chars.length > visualChars.length" class="tag">旁白仅保留声音</span>
              <span v-if="characterVolcStats.total" :class="['tag', characterVolcStats.missing ? 'tag-warning' : 'tag-success']">
                火山角色 {{ characterVolcStats.uploaded }}/{{ characterVolcStats.total }}
              </span>
              <div class="ml-auto flex gap-1">
                <BaseSelect
                  v-if="imageConfigSelectOptions.length > 1"
                  v-model="selectedImageModelKey"
                  :options="imageConfigSelectOptions"
                  placeholder="图片模型"
                  searchable
                  style="width:230px"
                />
                <BaseSelect
                  v-if="isEggfansGptImage2C"
                  v-model="selectedGptImage2CSize"
                  :options="gptImage2CSizeOptions"
                  placeholder="图片尺寸"
                  searchable
                  style="width:176px"
                />
                <button class="btn btn-sm" :disabled="!visualChars.length || uploadingCharacterImage" @click="openCharacterMaterialDialog">
                  上传角色素材
                </button>
                <button v-if="characterVolcStats.total" class="btn btn-sm" :disabled="!characterVolcStats.missing || uploadingCharacterImage" @click="syncAllCharacterVolcAssets(false)">
                  同步火山
                </button>
                <button class="btn btn-sm" @click="batchCharImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量生成
                </button>
              </div>
            </div>
            <div class="asset-grid">
              <div v-for="c in visualChars" :key="c.id" class="card asset-card">
                <div class="asset-cover">
                  <img
                    v-if="c.image_url || c.imageUrl"
                    :src="'/' + (c.image_url || c.imageUrl)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + (c.image_url || c.imageUrl), `${c.name} 角色设定稿`)"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="imageBadgeClass('character', c.id)">{{ imageBadgeLabel('character', c.id, c.image_url || c.imageUrl) }}</span>
                </div>
                <div class="asset-body">
                  <div class="asset-name">{{ c.name }}</div>
                  <div class="asset-meta dim">{{ c.role || '角色' }}</div>
                  <div v-if="getCharacterVolcAssetItem(c)" class="asset-volc-line">
                    <span :class="['tag', volcReferenceStatusClass(getCharacterVolcAssetItem(c))]">{{ volcReferenceStatusLabel(getCharacterVolcAssetItem(c)) }}</span>
                    <span class="asset-volc-id" :title="getCharacterVolcAssetItem(c).assetId || getCharacterVolcAssetItem(c).error || '等待上传生成资产 ID'">
                      {{ getCharacterVolcAssetItem(c).assetId || getCharacterVolcAssetItem(c).error || '等待上传生成资产 ID' }}
                    </span>
                  </div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (c.image_url || c.imageUrl) && 'ok', isPendingCharImage(c.id) && 'pending']" />
                  <span class="dim" style="font-size:10px">{{ imageBadgeLabel('character', c.id, c.image_url || c.imageUrl) }}</span>
                  <button
                    class="btn btn-sm"
                    :disabled="uploadingCharacterImage"
                    @click="chooseCharacterMaterial(c)"
                  >
                    {{ (c.image_url || c.imageUrl) ? '替换素材' : '上传素材' }}
                  </button>
                  <button
                    v-if="getCharacterVolcAssetItem(c)"
                    class="btn btn-sm"
                    :disabled="isPendingVolcAsset(getCharacterVolcAssetItem(c).key)"
                    @click="syncCharacterVolcAsset(c, !!getCharacterVolcAssetItem(c).asset)"
                  >
                    {{ isPendingVolcAsset(getCharacterVolcAssetItem(c).key) ? '上传中' : (getCharacterVolcAssetItem(c).asset ? '重传火山' : '上传火山') }}
                  </button>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingCharImage(c.id)" @click="retryOrGenerateImage('character', c.id, () => genCharImg(c.id))">{{ isPendingCharImage(c.id) ? '生成中' : (hasFailedImageGeneration('character', c.id) ? '重试生成' : ((c.image_url || c.imageUrl) ? '重新生成设定稿' : '生成设定稿')) }}</button>
                  <span v-if="imageGenerationError('character', c.id)" class="asset-generation-error" :title="imageGenerationError('character', c.id)">{{ imageGenerationError('character', c.id) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Scenes -->
          <div v-else-if="prodTab === 'scenes'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ scenes.length }} 个场景</span>
              <span v-if="imageConfigSelectOptions.length <= 1" class="tag">{{ effectiveImageConfigLabel }}</span>
              <span v-if="sceneVolcStats.total" :class="['tag', sceneVolcStats.missing ? 'tag-warning' : 'tag-success']">
                火山场景 {{ sceneVolcStats.uploaded }}/{{ sceneVolcStats.total }}
              </span>
              <div class="ml-auto flex gap-1">
                <BaseSelect
                  v-if="imageConfigSelectOptions.length > 1"
                  v-model="selectedImageModelKey"
                  :options="imageConfigSelectOptions"
                  placeholder="图片模型"
                  searchable
                  style="width:230px"
                />
                <BaseSelect
                  v-if="isEggfansGptImage2C"
                  v-model="selectedGptImage2CSize"
                  :options="gptImage2CSizeOptions"
                  placeholder="图片尺寸"
                  searchable
                  style="width:176px"
                />
                <button class="btn btn-sm" :disabled="!sceneVolcStats.total || !sceneVolcStats.missing" @click="syncAllSceneVolcAssets(false)">
                  上传场景素材
                </button>
                <button class="btn btn-sm" @click="batchSceneImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量生成
                </button>
              </div>
            </div>
            <div class="asset-grid">
              <div v-for="s in scenes" :key="s.id" class="card asset-card">
                <div class="asset-cover wide">
                  <img
                    v-if="s.image_url || s.imageUrl"
                    :src="'/' + (s.image_url || s.imageUrl)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + (s.image_url || s.imageUrl), `${s.location} 场景图`)"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="imageBadgeClass('scene', s.id)">{{ imageBadgeLabel('scene', s.id, s.image_url || s.imageUrl) }}</span>
                </div>
                <div class="asset-body">
                  <div class="asset-name">{{ s.location }}</div>
                  <div class="asset-meta dim">{{ s.time || '—' }}</div>
                  <div v-if="getSceneVolcAssetItem(s)" class="asset-volc-line">
                    <span :class="['tag', volcReferenceStatusClass(getSceneVolcAssetItem(s))]">{{ volcReferenceStatusLabel(getSceneVolcAssetItem(s)) }}</span>
                    <span class="asset-volc-id" :title="getSceneVolcAssetItem(s).assetId || getSceneVolcAssetItem(s).error || '等待上传生成资产 ID'">
                      {{ getSceneVolcAssetItem(s).assetId || getSceneVolcAssetItem(s).error || '等待上传生成资产 ID' }}
                    </span>
                  </div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (s.image_url || s.imageUrl) && 'ok', isPendingSceneImage(s.id) && 'pending']" />
                  <span class="dim" style="font-size:10px">{{ imageBadgeLabel('scene', s.id, s.image_url || s.imageUrl) }}</span>
                  <button
                    v-if="getSceneVolcAssetItem(s)"
                    class="btn btn-sm"
                    :disabled="isPendingVolcAsset(getSceneVolcAssetItem(s).key)"
                    @click="syncSceneVolcAsset(s, !!getSceneVolcAssetItem(s).asset)"
                  >
                    {{ isPendingVolcAsset(getSceneVolcAssetItem(s).key) ? '上传中' : (getSceneVolcAssetItem(s).asset ? '重传火山' : '上传火山') }}
                  </button>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingSceneImage(s.id)" @click="retryOrGenerateImage('scene', s.id, () => genSceneImg(s.id))">{{ isPendingSceneImage(s.id) ? '生成中' : (hasFailedImageGeneration('scene', s.id) ? '重试生成' : ((s.image_url || s.imageUrl) ? '重新生成' : '生成')) }}</button>
                  <span v-if="imageGenerationError('scene', s.id)" class="asset-generation-error" :title="imageGenerationError('scene', s.id)">{{ imageGenerationError('scene', s.id) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Dubbing -->
          <div v-else-if="prodTab === 'dubbing'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ ttsEligibleCount }} 条可生成配音</span>
              <span class="tag mono">{{ ttsGeneratedCount }}/{{ ttsEligibleCount }} 已生成</span>
              <span v-if="batchTTSRunning" class="tag tag-info mono">生成中 {{ ttsBatchProgress.done }}/{{ ttsBatchProgress.total }}</span>
              <span v-if="audioConfigSelectOptions.length <= 1" class="tag">{{ effectiveAudioConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <BaseSelect
                  v-if="audioConfigSelectOptions.length > 1"
                  v-model="selectedAudioModelKey"
                  :options="audioConfigSelectOptions"
                  placeholder="配音模型"
                  searchable
                  style="width:260px"
                />
                <button class="btn btn-sm" :disabled="batchTTSRunning || !ttsPendingCount" @click="batchShotTTS">
                  <Loader2 v-if="batchTTSRunning" :size="11" class="animate-spin" />
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                  {{ batchTTSRunning ? '批量生成中' : '批量生成' }}
                </button>
              </div>
            </div>

            <div v-if="!ttsEligibleCount" class="step-empty" style="min-height:260px">
              <div class="empty-visual">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              </div>
              <div class="empty-title">当前没有可生成的配音</div>
              <div class="empty-desc">先在分镜里填写“角色名：台词”或“旁白：文案”，这里就会出现待生成的语音镜头。</div>
            </div>

            <div v-else class="dub-grid">
                <div v-for="(sb, i) in sbs.filter(hasDialogue)" :key="sb.id" class="card dub-card">
                  <div class="dub-head">
                    <div class="dub-copy">
                    <div class="dub-title">
                      <span class="frame-num">#{{ String(sb.storyboard_number || sb.storyboardNumber || i + 1).padStart(2, '0') }}</span>
                      <span class="frame-badge">{{ getDialogueSpeaker(sb) }}</span>
                    </div>
                    <div class="dub-desc">
                      <div v-for="(line, lineIndex) in getDialogueLines(sb)" :key="lineIndex" class="dub-line">
                        <span v-if="line.speaker" class="dub-line-speaker">{{ line.speaker }}：</span>
                        <span>{{ line.text }}</span>
                      </div>
                    </div>
                    </div>
                    <span class="tag" :class="ttsStatusClass(sb)">
                      {{ ttsStatusLabel(sb) }}
                    </span>
                  </div>
                <div class="dub-meta">
                  <span class="dim">{{ sb.shot_type || sb.shotType || '未设景别' }}</span>
                  <span class="dim">{{ sb.duration || 5 }}s</span>
                  <span class="dim">{{ sb.location || '未设地点' }}</span>
                </div>
                <div v-if="ttsFailMessage(sb.id)" class="dub-error">{{ ttsFailMessage(sb.id) }}</div>
                <div class="dub-foot">
                  <Loader2 v-if="isPendingTTS(sb.id)" :size="14" class="animate-spin" style="color:var(--accent)" />
                  <audio v-if="hasTTS(sb)" :src="'/' + getTTSUrl(sb)" controls preload="none" class="dub-audio" />
                  <div v-else class="dim" style="font-size:12px">{{ isPendingTTS(sb.id) ? '正在生成语音文件...' : '尚未生成语音文件' }}</div>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingTTS(sb.id)" @click="genShotTTS(sb)">
                    {{ isPendingTTS(sb.id) ? '生成中' : (hasTTS(sb) ? '重新生成' : '生成配音') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Shots -->
          <div v-else-if="prodTab === 'shots'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
              <span class="tag mono">{{ shotImgCount }}/{{ sbs.length }} 已有帧图</span>
              <span v-if="frameMode !== 'multi_ref'" class="tag mono">首帧 {{ shotFirstFrameCount }}/{{ sbs.length }}</span>
              <span v-if="frameMode === 'first_last'" class="tag mono">尾帧 {{ shotLastFrameCount }}/{{ sbs.length }}</span>
              <span v-if="frameMode === 'multi_ref'" class="tag mono">参考图 {{ shotReferenceCount }}/{{ sbs.length }}</span>
              <span v-if="imageConfigSelectOptions.length <= 1" class="tag">{{ effectiveImageConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <BaseSelect
                  v-if="imageConfigSelectOptions.length > 1"
                  v-model="selectedImageModelKey"
                  :options="imageConfigSelectOptions"
                  placeholder="图片模型"
                  searchable
                  style="width:230px"
                />
                <BaseSelect
                  v-if="isEggfansGptImage2C"
                  v-model="selectedGptImage2CSize"
                  :options="gptImage2CSizeOptions"
                  placeholder="图片尺寸"
                  searchable
                  style="width:176px"
                />
                <BaseSelect v-model="frameMode" :options="frameModeOptions" placeholder="帧模式" searchable style="width:112px" />
                <button v-if="frameMode !== 'multi_ref'" class="btn btn-sm" :disabled="!missingFirstFrameShots.length" @click="batchShotFrames('first_frame')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量首帧
                </button>
                <button v-if="frameMode === 'first_last'" class="btn btn-sm" :disabled="!missingLastFrameShots.length" @click="batchShotFrames('last_frame')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量尾帧
                </button>
                <button v-if="frameMode === 'first_last'" class="btn btn-sm" :disabled="!missingShotFramePairs.length" @click="batchShotFrames('first_last')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量首尾帧
                </button>
                <button v-if="gridImagePath" class="btn btn-sm" @click="reopenGridPreview">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  查看当前宫格图
                </button>
                <button class="btn btn-primary btn-sm" @click="openGridTool">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  {{ frameMode === 'multi_ref' ? '制作参考宫格' : '宫格图工具' }}
                </button>
              </div>
            </div>

            <div v-if="gridHistory.length || allGridHistory.length" class="grid-history-panel">
              <div v-if="gridImagePath" class="latest-grid-strip">
                <button class="latest-grid-strip-thumb" @click="openImageViewer('/' + gridImagePath, '当前宫格图')">
                  <img :src="'/' + gridImagePath" class="previewable-image" />
                </button>
                <div class="latest-grid-strip-copy">
                  <div class="latest-grid-strip-head">
                    <span class="tag mono">{{ gridActualLayout.rows }}x{{ gridActualLayout.cols }}</span>
                    <span class="tag" v-if="gridRecoveredMode">{{ gridRecoveredMode }}</span>
                  </div>
                  <div class="latest-grid-strip-title">当前宫格图</div>
                  <div class="latest-grid-strip-meta">
                    <span v-if="gridRecoveredAt">{{ gridRecoveredAt }}</span>
                    <span>可继续切割并分配</span>
                  </div>
                </div>
                <div class="latest-grid-strip-actions">
                  <button class="btn btn-sm" @click="reopenGridPreview">预览</button>
                  <button class="btn btn-primary btn-sm" @click="continueGridSplit">继续切割</button>
                </div>
              </div>
              <div class="grid-history-head">
                <div>
                  <div class="grid-history-title">全部宫格历史</div>
                  <div class="grid-history-subtitle">可查看并切换所有分镜/批量宫格图，切割时会按该图自己的宫格数执行</div>
                </div>
                <button class="btn btn-sm" @click="showAllGridHistory = !showAllGridHistory">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline :points="showAllGridHistory ? '18 15 12 9 6 15' : '6 9 12 15 18 9'"/></svg>
                  {{ showAllGridHistory ? '收起历史宫格图' : `展开全部 (${allGridHistory.length || gridHistory.length})` }}
                </button>
              </div>
              <div v-if="showAllGridHistory" class="grid-history-list">
                <button
                  v-for="item in allGridHistory"
                  :key="item.id"
                  :class="['grid-history-item', { active: item.localPath === gridImagePath }]"
                  @click="selectGridHistory(item)"
                >
                  <div class="grid-history-thumb">
                    <img :src="'/' + item.localPath" class="previewable-image" />
                  </div>
                  <div class="grid-history-copy">
                    <div class="grid-history-tags">
                      <span class="tag mono">#{{ item.id }}</span>
                      <span class="tag mono">{{ item.layout.rows }}x{{ item.layout.cols }}</span>
                      <span class="tag">{{ item.modeLabel }}</span>
                      <span class="tag">{{ item.targetLabel }}</span>
                    </div>
                    <div class="grid-history-meta">{{ item.createdAtLabel }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div class="frame-scroll">
              <div class="frame-grid">
                <div v-for="(sb, i) in sbs" :key="sb.id"
                  :class="['frame-row', 'card', { active: selectedSb?.id === sb.id }]"
                  @click="selectedSb = sb">
                  <!-- Info: number + type + desc -->
                  <div class="frame-info">
                    <div class="frame-top">
                      <span class="frame-num">#{{ String(i+1).padStart(2,'0') }}</span>
                      <span class="frame-badge">{{ sb.shot_type || sb.shotType || '—' }}</span>
                    </div>
                    <div class="frame-desc">{{ sb.description || sb.title || '—' }}</div>
                    <div class="frame-meta">
                      <template v-if="frameMode === 'multi_ref'">
                        <span :class="['dot', getRefs(sb).length && 'ok']" />
                        <span class="dim" style="font-size:11px">参考图 {{ getRefs(sb).length }}</span>
                      </template>
                      <template v-else>
                        <span :class="['dot', getFirstFrame(sb) && 'ok', isPendingShotFrame(sb.id, 'first_frame') && 'pending']" />
                        <span class="dim" style="font-size:11px">首帧</span>
                      </template>
                      <span v-if="frameMode === 'first_last'" style="display:flex;align-items:center;gap:4px">
                        <span :class="['dot', getLastFrame(sb) && 'ok', isPendingShotFrame(sb.id, 'last_frame') && 'pending']" />
                        <span class="dim" style="font-size:11px">尾帧</span>
                      </span>
                    </div>
                  </div>
                  <!-- Thumbnails -->
                  <div class="frame-thumbs">
                    <template v-if="frameMode === 'multi_ref'">
                      <div class="frame-thumb-wrap">
                        <div class="frame-ref-strip">
                          <button
                            v-for="(ref, refIndex) in getRefs(sb).slice(0, 4)"
                            :key="`${sb.id}-ref-${refIndex}`"
                            class="frame-ref-thumb"
                            :title="`查看参考图 ${refIndex + 1}`"
                            @click.stop="openImageViewer('/' + ref, `镜头 #${String(i + 1).padStart(2, '0')} 参考图 ${refIndex + 1}`)"
                          >
                            <img :src="'/' + ref" class="previewable-image" />
                            <span v-if="getRefs(sb).length > 4 && refIndex === 3" class="frame-ref-more">+{{ getRefs(sb).length - 4 }}</span>
                          </button>
                          <button v-if="!getRefs(sb).length" class="frame-ref-thumb add" title="添加参考图" @click.stop="openGridToolForReference(sb)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          </button>
                        </div>
                        <div class="frame-ref-footer">
                          <span class="frame-thumb-label">{{ getRefs(sb).length ? `${getRefs(sb).length} 张参考图` : '添加参考图' }}</span>
                          <button v-if="getRefs(sb).length" class="frame-ref-add-link" @click.stop="openGridToolForReference(sb)">继续添加</button>
                        </div>
                      </div>
                    </template>
                    <div v-else class="frame-thumb-wrap">
                      <div class="frame-thumb" @click.stop="!isPendingShotFrame(sb.id, 'first_frame') && genShotFrame(sb, 'first_frame')">
                        <img
                          v-if="getFirstFrame(sb)"
                          :src="'/' + getFirstFrame(sb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getFirstFrame(sb), `镜头 #${String(i + 1).padStart(2, '0')} 首帧`)"
                        />
                        <div v-else class="frame-thumb-empty">
                          <Loader2 v-if="isPendingShotFrame(sb.id, 'first_frame')" :size="14" class="animate-spin" />
                          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <span v-if="getFirstFrame(sb)" class="frame-re">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        </span>
                      </div>
                      <span class="frame-thumb-label">{{ shotFrameLabel(sb, 'first_frame') }}</span>
                      <div v-if="shotFrameError(sb, 'first_frame')" class="frame-generation-error" :title="shotFrameError(sb, 'first_frame')">
                        <span>失败：{{ shotFrameError(sb, 'first_frame') }}</span>
                        <button class="frame-generation-retry" type="button" @click.stop="retryShotFrame(sb, 'first_frame')">重试</button>
                      </div>
                    </div>
                    <div v-if="frameMode === 'first_last'" class="frame-thumb-wrap">
                      <div class="frame-thumb" @click.stop="!isPendingShotFrame(sb.id, 'last_frame') && genShotFrame(sb, 'last_frame')">
                        <img
                          v-if="getLastFrame(sb)"
                          :src="'/' + getLastFrame(sb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getLastFrame(sb), `镜头 #${String(i + 1).padStart(2, '0')} 尾帧`)"
                        />
                        <div v-else class="frame-thumb-empty">
                          <Loader2 v-if="isPendingShotFrame(sb.id, 'last_frame')" :size="14" class="animate-spin" />
                          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <span v-if="getLastFrame(sb)" class="frame-re">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        </span>
                      </div>
                      <span class="frame-thumb-label">{{ shotFrameLabel(sb, 'last_frame') }}</span>
                      <div v-if="shotFrameError(sb, 'last_frame')" class="frame-generation-error" :title="shotFrameError(sb, 'last_frame')">
                        <span>失败：{{ shotFrameError(sb, 'last_frame') }}</span>
                        <button class="frame-generation-retry" type="button" @click.stop="retryShotFrame(sb, 'last_frame')">重试</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Grid Tool Dialog -->
            <div v-if="gridDialog" class="overlay" @click.self="gridDialog = false">
              <div class="card grid-tool">
                <div class="grid-tool-head">
                  <span style="font-size:15px;font-weight:600;font-family:var(--font-display)">宫格图工具</span>
                  <button class="btn btn-ghost btn-icon ml-auto" @click="gridDialog = false">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>

                <!-- Step 0: Config -->
                <div v-if="gridStep === 0" class="grid-tool-body">
                  <div class="grid-mode-tabs">
                    <button v-for="m in gridModes" :key="m.id"
                      :class="['grid-mode-tab', { active: gridMode === m.id }]"
                      @click="gridMode = m.id; gridSelected = []; gridSingleTarget = null; gridAssignmentsState = []">
                      <span style="font-weight:600">{{ m.label }}</span>
                      <span class="dim" style="font-size:11px">{{ m.desc }}</span>
                    </button>
                  </div>

                  <div class="grid-config">
                    <label class="field" style="flex:0 0 auto" v-if="gridMode !== 'multi_ref'">
                      <span class="field-label">宫格</span>
                      <BaseSelect v-model="gridLayout" :options="gridLayoutOptions" placeholder="宫格" style="width:90px" />
                    </label>
                    <div class="field" style="flex:1">
                      <span class="field-label">
                        {{ gridMode === 'multi_ref' ? '选择目标镜头' : '选择镜头' }}
                        <span class="dim" v-if="gridMode !== 'multi_ref'">(已选 {{ gridSelected.length }})</span>
                      </span>
                    </div>
                    <div style="align-self:flex-end" v-if="gridMode !== 'multi_ref'">
                      <button class="btn btn-sm" @click="gridSelectAll">{{ gridSelected.length === sbs.length ? '取消全选' : '全选' }}</button>
                    </div>
                  </div>

                  <div class="grid-pick-list">
                    <label v-for="(sb, i) in sbs" :key="sb.id"
                      :class="['grid-pick-item', { selected: gridMode === 'multi_ref' ? gridSingleTarget === sb.id : gridSelected.includes(sb.id) }]">
                      <input v-if="gridMode === 'multi_ref'" type="radio" :value="sb.id" v-model="gridSingleTarget" name="grid-target" />
                      <input v-else type="checkbox" :value="sb.id" v-model="gridSelected" />
                      <span class="mono" style="font-size:11px;width:28px">#{{ String(i+1).padStart(2,'0') }}</span>
                      <span class="truncate" style="flex:1;font-size:12px">{{ sb.description || sb.title || '—' }}</span>
                    </label>
                  </div>

                  <div class="grid-tool-foot">
                    <span v-if="gridCanStart" class="tag mono">{{ gridAutoLayout.rows }}x{{ gridAutoLayout.cols }} = {{ gridAutoLayout.rows * gridAutoLayout.cols }}格</span>
                    <span class="dim" style="font-size:11px">{{ gridPromptLoading ? gridPromptStatus : gridSummary }}</span>
                    <button class="btn btn-primary ml-auto" :disabled="!gridCanStart || gridPromptLoading" @click="generateGridPrompt">
                      <Loader2 v-if="gridPromptLoading" :size="12" class="animate-spin" />
                      <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      {{ gridPromptLoading ? '生成中' : '生成提示词' }}
                    </button>
                  </div>
                </div>

                <!-- Step 1: Prompt Preview -->
                <div v-else-if="gridStep === 1" class="grid-tool-body">
                  <div class="grid-prompt-summary">
                    <div class="grid-prompt-label">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                      宫格图提示词
                      <span v-if="gridPromptSource" class="tag ml-8">{{ gridPromptSource === 'agent' ? 'AI生成' : '模板兜底' }}</span>
                    </div>
                    <div class="grid-prompt-text">{{ gridPromptText || '（等待生成）' }}</div>
                  </div>
                  <div v-if="gridStatusText" class="grid-status-note">
                    {{ gridStatusText }}
                  </div>

                  <div class="grid-blank-preview" :style="gridBlankStyle">
                    <div v-for="(cell, i) in gridCellPrompts" :key="i" class="grid-blank-cell">
                      <div class="grid-blank-cell-index">#{{ cell.shot_number }} {{ {first_frame:'首帧',last_frame:'尾帧',reference:'参考'}[cell.frame_type] || '' }}</div>
                      <div class="grid-blank-cell-desc">{{ cell.prompt }}</div>
                    </div>
                    <div v-for="i in Math.max(0, (gridAutoLayout.rows * gridAutoLayout.cols) - gridCellPrompts.length)" :key="'empty-'+i" class="grid-blank-cell empty">
                      <div class="grid-blank-cell-index">空</div>
                      <div class="grid-blank-cell-desc">—</div>
                    </div>
                  </div>

                  <div class="grid-tool-foot">
                    <button class="btn" @click="gridStep = 0">上一步</button>
                    <button class="btn ml-auto" @click="generateGridPrompt" :disabled="gridPromptLoading">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                      重新生成
                    </button>
                    <button class="btn btn-primary" @click="startGridGen">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      生成宫格图
                    </button>
                  </div>
                </div>

                <!-- Step 2: Generating -->
                <div v-else-if="gridStep === 2" class="grid-tool-body" style="align-items:center;justify-content:center;min-height:300px">
                  <Loader2 :size="28" class="animate-spin" style="color:var(--accent)" />
                  <div class="loading-text" style="margin-top:12px">宫格图生成中...</div>
                  <div class="dim" style="font-size:11px;margin-top:6px">{{ gridStatusText }}</div>
                </div>

                <!-- Step 3: Preview -->
                <div v-else-if="gridStep === 3" class="grid-tool-body grid-tool-body-preview">
                  <div class="grid-preview-layout">
                    <div class="grid-preview-pane">
                      <div class="grid-preview-wrap">
                        <div class="grid-preview-stage">
                          <img
                            :src="'/' + gridImagePath"
                            class="grid-preview-img previewable-image"
                            @click.stop="openImageViewer('/' + gridImagePath, '宫格图预览')"
                          />
                          <div class="grid-overlay" :style="gridOverlayStyle">
                            <button
                              v-for="(a, i) in gridAssignments"
                              :key="i"
                              type="button"
                              :class="['grid-overlay-cell', activeGridCell === i && 'active']"
                              @click="focusGridCell(i)"
                            >
                              <span class="grid-cell-label">{{ gridCellLabel(a) }}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                      <div class="grid-adjust-summary">
                        <span class="tag mono">{{ gridActualLayout.rows }}x{{ gridActualLayout.cols }} = {{ gridActualLayout.rows * gridActualLayout.cols }}格</span>
                        <span class="dim" style="font-size:12px">{{ gridAssignedCount }}/{{ gridAssignments.length }} 格已分配</span>
                        <span class="tag" v-if="gridAssignedCount < gridAssignments.length">未分配格子会被忽略，不会写回分镜</span>
                      </div>
                    </div>
                    <div class="grid-assignment-pane">
                      <div class="grid-assign-head">
                        <div class="grid-assign-title">格子分配</div>
                        <div class="grid-assign-subtitle">切分后由你自己决定每格对应哪个分镜</div>
                      </div>
                      <div v-if="gridAssignmentTotalPages > 1" class="grid-assign-pagination">
                        <button class="btn btn-sm" :disabled="gridAssignmentPage === 0" @click="gridAssignmentPage--">上一页</button>
                        <span class="dim">第 {{ gridAssignmentPage + 1 }}/{{ gridAssignmentTotalPages }} 页</span>
                        <span class="dim">{{ gridAssignmentPageStart + 1 }}-{{ gridAssignmentPageEnd }} / {{ gridAssignments.length }}</span>
                        <button class="btn btn-sm ml-auto" :disabled="gridAssignmentPage >= gridAssignmentTotalPages - 1" @click="gridAssignmentPage++">下一页</button>
                      </div>
                      <div class="grid-assign-columns">
                        <span>格</span>
                        <span>镜头</span>
                        <span>类型</span>
                        <span>当前绑定</span>
                      </div>
                      <div class="grid-assign-info">
                        <div v-for="item in pagedGridAssignments" :key="item.index" :class="['grid-assign-row', activeGridCell === item.index && 'active']">
                          <span class="grid-assign-index">格{{ item.index + 1 }}</span>
                          <BaseSelect
                            :model-value="item.assignment.storyboard_id"
                            :options="gridAssignmentShotOptions"
                            placeholder="选择镜头"
                            @update:model-value="updateGridAssignment(item.index, 'storyboard_id', $event)"
                          />
                          <BaseSelect
                            :model-value="item.assignment.frame_type"
                            :options="gridFrameTypeOptions"
                            placeholder="帧类型"
                            style="width:100%"
                            @update:model-value="updateGridAssignment(item.index, 'frame_type', $event)"
                          />
                          <span class="grid-assign-bind">{{ gridCellTitle(item.assignment.storyboard_id) }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="grid-tool-foot">
                    <button class="btn" @click="gridStep = 1">返回</button>
                    <button class="btn btn-primary ml-auto" @click="doGridSplit">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                      切分并分配
                    </button>
                  </div>
                </div>

                <!-- Step 4: Done -->
                <div v-else-if="gridStep === 4" class="grid-tool-body" style="align-items:center;justify-content:center;min-height:200px">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <div style="font-size:17px;font-weight:700;font-family:var(--font-display);margin-top:8px">分配完成</div>
                  <div class="dim" style="font-size:13px;margin-top:4px">{{ gridAssignedCount }} 格已分配</div>
                  <button class="btn btn-primary" style="margin-top:16px" @click="gridDialog = false; refresh()">关闭</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Videos -->
          <div v-else-if="prodTab === 'videos'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
              <span class="tag mono">{{ shotVidCount }}/{{ sbs.length }} 已生成</span>
              <span v-if="usesVolcAssetVideoReferences" :class="['tag', volcReferenceStats.missing ? 'tag-warning' : 'tag-success']">
                火山素材 {{ volcReferenceStats.uploaded }}/{{ volcReferenceStats.total }}
              </span>
              <span v-else-if="usesGrokPublicVideoReferences" class="tag">
                Grok公网参考 {{ grokVideoReferenceReadyCount }}/{{ sbs.length }} · 每镜头最多7张
              </span>
              <span v-if="videoConfigSelectOptions.length <= 1" class="tag">{{ effectiveVideoConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <BaseSelect
                  v-if="videoConfigSelectOptions.length > 1"
                  v-model="selectedVideoModelKey"
                  :options="videoConfigSelectOptions"
                  placeholder="视频模型"
                  searchable
                  style="width:250px"
                />
                <BaseSelect
                  v-model="selectedVideoAspectRatio"
                  :options="videoAspectRatioOptions"
                  placeholder="视频比例"
                  style="width:142px"
                />
                <button v-if="usesVolcAssetVideoReferences" class="btn btn-sm" :disabled="!volcReferenceStats.total || !volcReferenceStats.missing" @click="syncAllVolcReferences(false)">
                  上传全部参考图
                </button>
                <button
                  v-if="usesSequentialVideo"
                  class="btn btn-sm btn-primary"
                  :disabled="!sbs.length || sequenceBusy"
                  @click="startSequentialGeneration"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v16l14-8L5 4Z" /></svg>
                  {{ sequenceBusy ? '串行生成中' : '一键串行生成' }}
                </button>
                <button class="btn btn-sm" :disabled="!batchVideoTargetCount" @click="batchVideos">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  {{ batchVideoButtonLabel }}
                </button>
              </div>
            </div>
            <div v-if="videoSequence" class="video-sequence-panel">
              <div class="video-sequence-head">
                <div>
                  <strong>{{ sequenceProviderLabel }}串行生成</strong>
                  <span class="dim">镜头 {{ sequenceCompletedCount }}/{{ videoSequence.total_count || videoSequence.totalCount || sbs.length }} · {{ sequenceReferenceLimitLabel }}</span>
                </div>
                <div class="video-sequence-actions">
                  <span :class="['tag', sequenceStatusClass(videoSequence.status)]">{{ sequenceStatusLabel(videoSequence.status) }}</span>
                  <button v-if="sequenceBusy" class="btn btn-sm" @click="cancelSequentialGeneration(videoSequence.id)">停止</button>
                  <button v-if="videoSequence.status === 'failed'" class="btn btn-sm btn-primary" @click="retrySequentialGeneration(videoSequence.id)">从失败处继续</button>
                </div>
              </div>
              <div class="video-sequence-progress"><span :style="{ width: `${sequenceProgress}%` }"></span></div>
              <div class="video-sequence-note">
                {{ sequenceStatusDetail(videoSequence) }}
                <span v-if="videoSequence.error_msg || videoSequence.errorMsg" class="sequence-error">{{ videoSequence.error_msg || videoSequence.errorMsg }}</span>
              </div>
              <div v-if="sequenceCurrentStep" class="video-sequence-step-detail">
                当前镜头参考 {{ sequenceAssetCount(sequenceCurrentStep) }}/{{ sequenceAssetLimit }}
                <span v-if="sequenceCurrentStep.first_frame_asset_id || sequenceCurrentStep.firstFrameAssetId"> · 首帧资产 {{ sequenceCurrentStep.first_frame_asset_id || sequenceCurrentStep.firstFrameAssetId }}</span>
                <span v-if="sequenceCurrentStep.video_generation_id || sequenceCurrentStep.videoGenerationId"> · 视频任务 #{{ sequenceCurrentStep.video_generation_id || sequenceCurrentStep.videoGenerationId }}</span>
              </div>
              <div v-if="sequenceCurrentAssets.length" class="video-sequence-assets">
                <span v-for="item in sequenceCurrentAssets" :key="`${item.role}-${item.asset_id || item.assetUri}`" class="tag" :title="item.asset_uri || item.assetUri || item.asset_id || item.assetId">
                  {{ sequenceAssetLabel(item) }}
                </span>
              </div>
            </div>
            <div class="prod-grid prod-grid-videos">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="card prod-card">
                <div class="prod-cover">
	                  <video
	                    v-if="hasVid(sb)"
	                    :src="mediaSrc(getDisplayShotVideoUrl(sb))"
	                    class="prod-video"
	                    controls
	                    preload="metadata"
	                    playsinline
	                  />
	                  <button
	                    v-if="hasVid(sb)"
	                    class="video-preview-btn"
	                    title="全屏预览"
	                    @click.stop="openVideoViewer(sb, `镜头 #${String(i + 1).padStart(2, '0')} 视频`)"
	                  >
	                    全屏预览
	                  </button>
                  <div
                    v-else-if="getRefs(sb).length"
                    class="prod-ref-grid"
                    :class="{ compact: getRefs(sb).length < 4 }"
                  >
                    <button
                      v-for="(ref, refIndex) in getRefs(sb).slice(0, 4)"
                      :key="`${sb.id}-video-ref-${refIndex}`"
                      class="prod-ref-tile"
                      :title="`查看参考图 ${refIndex + 1}`"
                      @click.stop="openImageViewer('/' + ref, `镜头 #${String(i + 1).padStart(2, '0')} 参考图 ${refIndex + 1}`)"
                    >
                      <img :src="'/' + ref" class="previewable-image" />
                      <span v-if="getRefs(sb).length > 4 && refIndex === 3" class="prod-ref-more">+{{ getRefs(sb).length - 4 }}</span>
                    </button>
                    <span class="prod-ref-badge">{{ getRefs(sb).length }} 张参考图</span>
                  </div>
                  <img
                    v-else-if="hasImg(sb)"
                    :src="'/' + getStoryboardCover(sb)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + getStoryboardCover(sb), `镜头 #${String(i + 1).padStart(2, '0')} 参考图`)"
                  />
                  <div v-else class="prod-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  </div>
                  <span class="prod-idx">#{{ String(i+1).padStart(2,'0') }}</span>
                  <span v-if="hasComposed(sb)" class="prod-overlay-badge">已合成</span>
                </div>
                <div class="prod-info">
                  <div class="prod-desc truncate">{{ sb.description || sb.title || '—' }}</div>
                  <div class="prod-meta-line">{{ sb.shot_type || sb.shotType || '未设景别' }} · {{ sb.duration || 5 }}s</div>
                  <div class="prod-dots">
                    <span :class="['dot', hasVideoReferenceInput(sb) && 'ok']" /><span style="font-size:10px">{{ getRefs(sb).length ? `参考图 ${getRefs(sb).length}` : '图' }}</span>
                    <span :class="['dot', hasVid(sb) && 'ok', isVideoBusy(sb.id) && 'pending']" /><span style="font-size:10px">{{ isVideoBusy(sb.id) ? '视频生成中' : '视频' }}</span>
                  </div>
                  <div v-if="usesVolcAssetVideoReferences && getVolcReferenceItems(sb).length" class="volc-ref-panel">
                    <div class="volc-ref-head">
                      <span>火山素材</span>
                      <button class="btn btn-sm" :disabled="getVolcReferenceItems(sb).every(item => item.asset || isPendingVolcAsset(item.key))" @click="syncStoryboardVolcReferences(sb, false)">
                        上传本镜头
                      </button>
                    </div>
                    <div class="volc-ref-list">
                      <div v-for="item in getVolcReferenceItems(sb)" :key="item.key" class="volc-ref-row">
                        <button class="volc-ref-thumb" :title="`查看参考图 ${item.index + 1}`" @click.stop="openImageViewer('/' + item.url, `镜头 #${String(i + 1).padStart(2, '0')} 火山参考图 ${item.index + 1}`)">
                          <img :src="'/' + item.url" class="previewable-image" />
                        </button>
                        <div class="volc-ref-body">
                          <div class="volc-ref-title">
                            <span>参考图 {{ item.index + 1 }}</span>
                            <span :class="['tag', volcReferenceStatusClass(item)]">{{ volcReferenceStatusLabel(item) }}</span>
                          </div>
                          <div class="volc-ref-id" :title="item.assetId || item.error || '尚未上传火山素材'">
                            {{ item.assetId || item.error || '等待上传生成资产 ID' }}
                          </div>
                        </div>
                        <button class="btn btn-sm" :disabled="isPendingVolcAsset(item.key)" @click="syncVolcReference(sb, item, !!item.asset)">
                          {{ isPendingVolcAsset(item.key) ? '上传中' : (item.asset ? '重传' : '上传') }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="usesGrokPublicVideoReferences && getGrokVideoReferenceItems(sb).length" class="volc-ref-panel public-ref-panel">
                    <div class="volc-ref-head">
                      <span>Grok公网参考</span>
                      <span class="tag tag-success">{{ getGrokVideoReferenceItems(sb).length }}/7</span>
                    </div>
                    <div class="volc-ref-list">
                      <div v-for="item in getGrokVideoReferenceItems(sb)" :key="item.key" class="volc-ref-row">
                        <button class="volc-ref-thumb" :title="`查看${item.label}`" @click.stop="openImageViewer(mediaSrc(item.url), `镜头 #${String(i + 1).padStart(2, '0')} ${item.label}`)">
                          <img :src="mediaSrc(item.url)" class="previewable-image" />
                        </button>
                        <div class="volc-ref-body">
                          <div class="volc-ref-title">
                            <span>{{ item.label }}</span>
                            <span class="tag tag-info">生成时上传</span>
                          </div>
                          <div class="volc-ref-id" :title="item.url">
                            {{ item.url }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="video-prompt-panel">
                    <div class="video-prompt-head">
                      <span>传输提示词</span>
                      <span v-if="latestVideoPromptIsFinal(sb.id)" class="tag tag-success">最终稿</span>
	                      <button class="btn btn-sm" @click="toggleVideoPromptEditor(sb)">
	                        {{ isVideoPromptEditorOpen(sb.id) ? '收起' : '查看/编辑' }}
	                      </button>
                    </div>
                    <div v-if="isVideoPromptEditorOpen(sb.id)" class="video-prompt-editor">
                      <textarea
                        class="video-prompt-textarea"
                        :value="videoPromptDraft(sb)"
                        @input="setVideoPromptDraft(sb.id, $event.target.value)"
                        placeholder="这里展示/编辑实际传给视频模型的提示词。编辑后点击重新生成，会按这里的内容直接提交。"
	                      />
	                      <div class="video-prompt-actions">
	                        <button class="btn btn-sm" @click="resetVideoPromptDraft(sb)">恢复分镜提示词</button>
	                        <button class="btn btn-sm" :disabled="isPreviewingVideoPrompt(sb.id)" @click="refreshVideoPromptDraft(sb)">
	                          {{ isPreviewingVideoPrompt(sb.id) ? '刷新中' : '刷新传输稿' }}
	                        </button>
	                          <button class="btn btn-sm btn-primary" :disabled="isVideoBusy(sb.id) || isPreviewingVideoPrompt(sb.id)" @click="genVid(sb, true)">
	                          按此提示词重生成
	                        </button>
                      </div>
                    </div>
                  </div>
                  <div v-if="videoFailMessage(sb.id)" class="prod-error">{{ videoFailMessage(sb.id) }}</div>
                </div>
	                <div class="prod-actions">
	                  <button class="btn btn-sm" :disabled="isVideoBusy(sb.id)" @click="genVid(sb)">
	                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
	                    {{ isVideoBusy(sb.id) ? '生成中' : (hasVid(sb) ? '重新生成' : '生成视频') }}
	                  </button>
	                  <button v-if="hasVid(sb)" class="btn btn-sm" :disabled="isExportingVideo(sb)" @click="exportShotVideoToDesktop(sb)">
	                    <Download size="11" />
	                    {{ isExportingVideo(sb) ? '保存中' : '保存桌面' }}
	                  </button>
	                  <a
	                    v-if="hasVid(sb) && getDownloadShotVideoUrl(sb)"
	                    :href="mediaSrc(getDownloadShotVideoUrl(sb))"
	                    download
	                    class="btn btn-sm"
	                  >
	                    <Download size="11" />
	                    下载
	                  </a>
	                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Compose -->
          <div v-else-if="prodTab === 'compose'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
                <span class="tag mono">{{ composedCount }}/{{ mergeCandidateCount }} 已合成</span>
              <div class="compose-audio-mode" role="group" aria-label="合成音频模式">
                <button
                  v-for="option in composeAudioModeOptions"
                  :key="option.value"
                  type="button"
                  class="compose-audio-option"
                  :class="{ active: composeAudioMode === option.value }"
                  @click="composeAudioMode = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchCompose">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  批量合成
                </button>
              </div>
            </div>
            <div class="prod-grid">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="card prod-card">
                <div class="prod-cover">
                  <video
                    v-if="hasComposed(sb)"
                    :src="mediaSrc(getComposedVideoUrl(sb))"
                    class="prod-video"
                    controls
                    preload="metadata"
                    playsinline
                  />
	                  <video
	                    v-else-if="hasVid(sb)"
	                    :src="mediaSrc(getDisplayShotVideoUrl(sb))"
	                    class="prod-video"
	                    controls
	                    preload="metadata"
                    playsinline
                  />
                  <img
                    v-else-if="hasImg(sb)"
                    :src="'/' + getStoryboardCover(sb)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + getStoryboardCover(sb), `镜头 #${String(i + 1).padStart(2, '0')} 参考图`)"
                  />
                  <div v-else class="prod-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </div>
                  <span class="prod-idx">#{{ String(i+1).padStart(2,'0') }}</span>
                  <span v-if="hasComposed(sb)" class="prod-overlay-badge">已合成</span>
                </div>
                <div class="prod-info">
                  <div class="prod-desc truncate">{{ sb.description || sb.title || '—' }}</div>
                  <div class="prod-meta-line">{{ sb.shot_type || sb.shotType || '未设景别' }} · {{ sb.duration || 5 }}s</div>
                  <div class="prod-dots">
                    <span :class="['dot', hasVid(sb) && 'ok']" /><span style="font-size:10px">视频</span>
                    <span :class="['dot', composeAudioMode !== 'tts' || hasTTS(sb) ? 'ok' : '']" /><span style="font-size:10px">{{ composeAudioStatusLabel(sb) }}</span>
                    <span :class="['dot', hasComposed(sb) && 'ok', isPendingCompose(sb.id) && 'pending']" /><span style="font-size:10px">{{ isPendingCompose(sb.id) ? '合成中' : '合成' }}</span>
                  </div>
                  <div v-if="composeFailMessage(sb.id)" class="prod-error">{{ composeFailMessage(sb.id) }}</div>
                </div>
                <div class="prod-actions">
                  <button class="btn btn-sm" :disabled="!hasVid(sb) || isPendingCompose(sb.id)" @click="doCompose(sb)">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    {{ isPendingCompose(sb.id) ? '合成中' : (hasComposed(sb) ? '重新合成' : '开始合成') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Production Navigator -->
        </template>
      </div>

      <!-- ===== EXPORT PANEL ===== -->
      <div v-else class="content-panel">
        <div v-if="!sbs.length" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="empty-title">尚未准备就绪</div>
          <div class="empty-desc">请先完成分镜和制作流程</div>
          <button class="btn btn-primary" @click="panel = 'script'">前往剧本</button>
        </div>
        <div v-else class="export-split">
          <div class="export-main">
            <template v-if="mergeUrl">
              <video :src="'/' + mergeUrl" controls class="export-video" />
              <div class="export-bar">
                <span class="tag tag-success">拼接完成</span>
                <span class="dim" style="font-size:12px">{{ sbs.length }} 镜头 · {{ totalDuration }}s</span>
                <button class="btn ml-auto" :disabled="exportDesktopBusy" @click="exportMergedToDesktop">
                  <Download size="13" />
                  {{ exportDesktopBusy ? '保存中' : '保存到桌面' }}
                </button>
                <a :href="'/' + mergeUrl" download class="btn btn-primary">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  下载视频
                </a>
              </div>
            </template>
            <template v-else>
              <div class="step-empty">
                <div class="empty-visual">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                </div>
                <div class="empty-title">拼接全集视频</div>
                <div class="empty-desc">将 {{ mergeCandidateCount }} 个有效镜头拼接为完整视频</div>
                <div v-if="mergeErrorMessage" class="export-error">{{ mergeErrorMessage }}</div>
                <button class="btn btn-primary" :disabled="!canExport || mergeBusy" @click="doMerge" style="margin-top:12px">
                  <Loader2 v-if="mergeBusy" :size="13" class="animate-spin" />
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  {{ mergeBusy ? '拼接中' : '开始拼接' }}
                </button>
              </div>
            </template>
          </div>
          <div class="export-list">
            <div class="export-list-head">镜头概览</div>
            <div class="export-list-body">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="exp-row">
                <span class="mono dim" style="font-size:10px">#{{ String(i+1).padStart(2,'0') }}</span>
                <span class="truncate" style="flex:1;font-size:11px">{{ sb.description || sb.title || '—' }}</span>
                <span :class="['dot', hasComposed(sb) && 'ok']" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="showBottomBubble" class="step-bubble">
        <button
          v-if="panel === 'script'"
          class="bubble-btn"
          :disabled="scriptStep === 0"
          @click="goPrevStep"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ prevStepLabel || '上一步' }}
        </button>
        <button
          v-else-if="panel === 'production'"
          class="bubble-btn"
          :disabled="prodTabIdx === 0"
          @click="prodTabIdx = Math.max(0, prodTabIdx - 1)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ prodTabDefs[Math.max(0, prodTabIdx - 1)]?.label || '上一步' }}
        </button>

        <div class="bubble-dots">
          <button
            v-for="step in bubbleSteps"
            :key="step.key"
            :class="['bubble-dot', { done: step.done, current: step.key === activeBubbleKey }]"
            @click="goSubStep(step.key)"
            :title="step.label"
          ></button>
        </div>

        <button
          v-if="panel === 'script'"
          class="bubble-btn primary"
          :disabled="!canGoNext"
          @click="goNextStep"
        >
          {{ nextStepLabel || '下一步' }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
        <button
          v-else-if="panel === 'production'"
          class="bubble-btn primary"
          :disabled="panel === 'production' && prodTab === 'compose' && !canExport"
          @click="goNextProd"
        >
          {{ prodTabIdx < prodTabDefs.length - 1 ? (prodTabDefs[prodTabIdx + 1]?.label || '下一步') : '进入导出' }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
      </div>

      <div v-if="imageViewer.open && imageViewer.src" class="overlay image-viewer-overlay" @click.self="closeImageViewer">
        <div class="card image-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ imageViewer.title || '图片预览' }}</div>
            <button class="btn btn-ghost btn-icon" @click="closeImageViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body">
            <img :src="imageViewer.src" :alt="imageViewer.title || '图片预览'" class="image-viewer-img" />
          </div>
        </div>
      </div>

      <div v-if="videoViewer.open && videoViewer.src" class="overlay image-viewer-overlay video-viewer-overlay" @click.self="closeVideoViewer">
        <div class="card image-viewer-dialog video-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ videoViewer.title || '视频预览' }}</div>
            <button class="btn btn-ghost btn-icon" @click="closeVideoViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body video-viewer-body">
            <video :src="videoViewer.src" class="video-viewer-player" controls autoplay playsinline />
          </div>
        </div>
      </div>

      <input
        ref="characterMaterialInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style="display:none"
        @change="handleCharacterMaterialFile"
      />

      <div v-if="characterMaterialDialog" class="overlay" @click.self="closeCharacterMaterialDialog">
        <div class="card character-material-dialog">
          <div class="character-material-head">
            <div>
              <div class="character-material-title">上传角色素材</div>
              <div class="dim character-material-subtitle">选择一个角色，再从电脑选择对应图片</div>
            </div>
            <button class="btn btn-ghost btn-icon" @click="closeCharacterMaterialDialog">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="character-material-list">
            <div v-for="c in visualChars" :key="c.id" class="character-material-row">
              <div class="character-material-thumb">
                <img v-if="c.image_url || c.imageUrl" :src="mediaSrc(c.image_url || c.imageUrl)" :alt="c.name" />
                <Users v-else :size="18" />
              </div>
              <div class="character-material-copy">
                <strong>{{ c.name }}</strong>
                <span>{{ c.role || '角色' }}</span>
              </div>
              <button class="btn btn-sm" :disabled="uploadingCharacterImage" @click="chooseCharacterMaterial(c)">
                {{ (c.image_url || c.imageUrl) ? '替换图片' : '选择图片' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  Users, MapPin, Video, ImageIcon, Layers, Mic2, FileText, FolderKanban, Clapperboard, Download, Loader2,
} from 'lucide-vue-next'
import { dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, imageAPI, videoAPI, composeAPI, mergeAPI, gridAPI, aiConfigAPI, voicesAPI, assetAPI, agentAPI, preferenceAPI } from '~/composables/useApi'
import { useAgent } from '~/composables/useAgent'
import BaseSelect from '~/components/BaseSelect.vue'
import { resolveEffectiveGenerationConfigId } from '~/utils/generation-config'
import { createGridAssignmentsForShots, normalizeGridAssignments, parseGridLayoutFromFrameType } from '~/utils/grid-state'
import { imagePath, shouldFinishImageRegenerationPoll } from '~/utils/image-generation-status'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const drama = ref(null), episode = ref(null), chars = ref([]), scenes = ref([]), sbs = ref([]), mergeData = ref(null), assets = ref([]), videoGenerations = ref([])
const panel = ref('script')
const { running: rn, runningType: rt, error: agentError, errorType: agentErrorType, run: runAgent } = useAgent()
const exportDesktopBusy = ref(false)
const mergeBusy = ref(false)
let mergeTimer = null

const localRaw = ref(''), localScript = ref('')
// 记录用户是否明确保存/修改了原始内容，避免重新提取时误读旧的格式化剧本。
const rawExtractionRequested = ref(false)
const rawContent = computed(() => episode.value?.content || '')
const scriptContent = computed(() => episode.value?.script_content || episode.value?.scriptContent || '')
const epId = computed(() => episode.value?.id || 0)
const rawLen = computed(() => localRaw.value.replace(/\s/g, '').length || 0)
const scriptLen = computed(() => localScript.value.replace(/\s/g, '').length || 0)
const hasExtractedAssets = computed(() => chars.value.length > 0 || scenes.value.length > 0)
const charsVoiced = computed(() => chars.value.filter(c => c.voice_style || c.voiceStyle).length)
const voiceSampleCount = computed(() => chars.value.filter(c => c.voice_sample_url || c.voiceSampleUrl).length)
const mergeCandidates = computed(() => sbs.value.filter(s => hasVid(s) || hasComposed(s)))
const mergeCandidateCount = computed(() => mergeCandidates.value.length)
const composedCount = computed(() => mergeCandidates.value.filter(s => hasComposed(s)).length)
const mergeUrl = computed(() => mergeData.value?.merged_url || mergeData.value?.mergedUrl || null)
const mergeErrorMessage = computed(() => {
  if (String(mergeData.value?.status || '').toLowerCase() !== 'failed') return ''
  return mergeData.value?.error_msg || mergeData.value?.errorMsg || '拼接失败，请检查镜头视频和本地存储权限'
})

const scriptStep = ref(0)
const prodTab = ref('chars')
const characterMaterialDialog = ref(false)
const characterMaterialInput = ref(null)
const characterMaterialTargetId = ref(null)
const uploadingCharacterImage = ref(false)
const prodTabIdx = computed({
  get: () => prodTabDefs.value.findIndex(t => t.id === prodTab.value),
  set: (v) => { prodTab.value = prodTabDefs.value[v]?.id || 'chars' },
})
const frameMode = ref('first')
const dubbingEnabled = ref(false)
const composeAudioMode = ref('original')
const composeAudioModeOptions = computed(() => [
  ...(dubbingEnabled.value ? [{ label: '配音', value: 'tts' }] : []),
  { label: '原声', value: 'original' },
  { label: '静音', value: 'silent' },
])
const composeRequestOptions = computed(() => ({
  audio_mode: dubbingEnabled.value ? composeAudioMode.value : 'original',
  subtitle_mode: dubbingEnabled.value && composeAudioMode.value === 'tts' ? 'auto' : 'none',
}))

const dubbingStatusLabel = computed(() => dubbingEnabled.value ? '已开启' : '已关闭')
const fallbackVoiceProfiles = [
  { id: 'male-qn-qingse', label: '青涩青年音色', gender: '男声', traits: '年轻、清澈、自然', suitable: '年轻男主、少年感角色' },
  { id: 'male-qn-jingying', label: '精英青年音色', gender: '男声', traits: '沉稳、干练、清晰', suitable: '都市男主、精英、叙事男声' },
  { id: 'male-qn-badao', label: '霸道青年音色', gender: '男声', traits: '强势、低沉、有压迫感', suitable: '霸总、反派、权势角色' },
  { id: 'male-qn-daxuesheng', label: '青年大学生音色', gender: '男声', traits: '阳光、年轻、生活化', suitable: '学生、邻家男孩、轻松男声' },
  { id: 'female-shaonv', label: '少女音色', gender: '女声', traits: '清亮、年轻、灵动', suitable: '少女、女主、年轻配角' },
  { id: 'female-yujie', label: '御姐音色', gender: '女声', traits: '成熟、冷静、有气场', suitable: '女强人、御姐、反派女性' },
  { id: 'female-chengshu', label: '成熟女性音色', gender: '女声', traits: '温和、稳重、可信', suitable: '母亲、成熟女主、旁白' },
  { id: 'female-tianmei', label: '甜美女性音色', gender: '女声', traits: '甜润、亲和、轻快', suitable: '甜美女主、温柔女性、轻喜角色' },
]
const voiceProfiles = ref(fallbackVoiceProfiles)
const voiceSelectOptions = computed(() => voiceProfiles.value.map(v => ({ label: `${v.label} · ${v.traits}`, value: v.id })))
const frameModeOptions = [
  { label: '仅首帧', value: 'first' },
  { label: '首尾帧', value: 'first_last' },
  { label: '多图参考', value: 'multi_ref' },
]
const gridLayoutOptions = [
  { label: '1x4', value: '1x4' },
  { label: '2x2', value: '2x2' },
  { label: '2x3', value: '2x3' },
  { label: '2x4', value: '2x4' },
  { label: '3x3', value: '3x3' },
  { label: '3x4', value: '3x4' },
  { label: '4x4', value: '4x4' },
  { label: '4x5', value: '4x5' },
  { label: '5x5', value: '5x5' },
]
const imageConfigs = ref([])
const videoConfigs = ref([])
const audioConfigs = ref([])
const storyboardAgentRuntime = ref(null)
const selectedImageModelKey = ref('')
const selectedGptImage2CSize = ref('3840x2160')
const gptImage2CSizeOptions = [
  { label: '4K 横版 · 3840x2160', value: '3840x2160' },
  { label: '4K 竖版 · 2160x3840', value: '2160x3840' },
  { label: '2K 正方形 · 2048x2048', value: '2048x2048' },
  { label: '2K 横版 · 2048x1152', value: '2048x1152' },
  { label: '2K 竖版 · 1152x2048', value: '1152x2048' },
  { label: '横版 · 1536x1024', value: '1536x1024' },
  { label: '竖版 · 1024x1536', value: '1024x1536' },
  { label: '正方形 · 1024x1024', value: '1024x1024' },
  { label: '自动 · auto', value: 'auto' },
]
const selectedVideoModelKey = ref('')
const selectedVideoAspectRatio = ref('16:9')
const selectedAudioModelKey = ref('')
const modelPreferenceKey = 'model-preferences-selected'
const videoAspectRatioPreferenceKey = 'video-generation-aspect-ratio'
let modelPreferencesHydrated = false
let modelPreferenceSave = Promise.resolve()
const pendingCharImageIds = ref([])
const pendingSceneImageIds = ref([])
const pendingShotFrameKeys = ref([])
const shotFrameRuntimeErrors = ref({})
const imageGenerations = ref([])
const pendingVideoIds = ref([])
const pendingComposeIds = ref([])
const pendingVolcAssetKeys = ref([])
const pendingTTSIds = ref([])
const failedTTSMessages = ref({})
const batchTTSRunning = ref(false)
const ttsBatchProgress = ref({ done: 0, total: 0 })
const manualVolcAssetFailures = ref({})
const failedVideoMessages = ref({})
const failedComposeMessages = ref({})
const imageViewer = ref({ open: false, src: '', title: '' })
const videoViewer = ref({ open: false, src: '', title: '' })
const exportingVideoIds = ref([])
const openVideoPromptIds = ref([])
const videoPromptDrafts = ref({})
const videoPromptDraftVersions = ref({})
const previewingVideoPromptIds = ref([])
const videoSequence = ref(null)
let videoSequenceTimer = null

function parseConfigModels(config) {
  if (!config?.model) return []
  if (Array.isArray(config.model)) return config.model.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof config.model === 'string') {
    const trimmed = config.model.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean)
      if (parsed) return [String(parsed)]
    } catch {}
    return trimmed.split(',').map(item => item.trim()).filter(Boolean)
  }
  return [String(config.model)]
}

function firstConfigModel(config) {
  return parseConfigModels(config)[0] || ''
}

function configLabel(config) {
  if (!config) return '未配置'
  const modelName = firstConfigModel(config)
  return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
}

function selectedConfigModelLabel(config, modelName = '') {
  if (!config) return '未配置'
  const resolvedModel = modelName || firstConfigModel(config)
  return resolvedModel ? `${config.name} · ${resolvedModel} (${config.provider})` : `${config.name} (${config.provider})`
}

function configOptionLabel(config) {
  const modelName = firstConfigModel(config)
  return modelName ? `${modelName} · ${config.name} (${config.provider})` : `${config.name} (${config.provider})`
}

function generationOptionKey(configId, modelName = '') {
  return `${configId}:${encodeURIComponent(modelName || '')}`
}

function parseGenerationOptionKey(key) {
  const [rawConfigId, rawModel = ''] = String(key || '').split(':')
  const configId = Number(rawConfigId)
  if (!Number.isInteger(configId) || configId <= 0) return { configId: null, model: '' }
  return {
    configId,
    model: decodeURIComponent(rawModel || ''),
  }
}

function selectConfigOptions(configs) {
  return configs.filter(config => config?.is_active !== false && config?.isActive !== false).flatMap(config => {
    if (!config?.id) return []
    const models = parseConfigModels(config)
    if (!models.length) return [{ label: configOptionLabel(config), value: generationOptionKey(config.id) }]
    return models.map(modelName => ({
      label: `${modelName} · ${config.name} (${config.provider})`,
      value: generationOptionKey(config.id, modelName),
    }))
  })
}

const imageConfigSelectOptions = computed(() => selectConfigOptions(imageConfigs.value))
const videoConfigSelectOptions = computed(() => selectConfigOptions(videoConfigs.value))
const audioConfigSelectOptions = computed(() => selectConfigOptions(audioConfigs.value))
const activeImageConfigs = computed(() => imageConfigs.value.filter(config => config?.is_active !== false && config?.isActive !== false))
const activeVideoConfigs = computed(() => videoConfigs.value.filter(config => config?.is_active !== false && config?.isActive !== false))
const activeAudioConfigs = computed(() => audioConfigs.value.filter(config => config?.is_active !== false && config?.isActive !== false))

function isPendingCharImage(id) {
  return pendingCharImageIds.value.includes(id) || imageGenerations.value.some((generation) => {
    const characterId = Number(generation?.character_id || generation?.characterId || 0)
    return characterId === Number(id) && isImageGenerationPending(generation)
  })
}

function openImageViewer(src, title = '') {
  if (!src) return
  imageViewer.value = { open: true, src, title }
}

function closeImageViewer() {
  imageViewer.value = { open: false, src: '', title: '' }
}

function openCharacterMaterialDialog() {
  if (!visualChars.value.length) {
    toast.warning('当前没有可上传的角色')
    return
  }
  characterMaterialDialog.value = true
}

function closeCharacterMaterialDialog() {
  if (uploadingCharacterImage.value) return
  characterMaterialDialog.value = false
  characterMaterialTargetId.value = null
}

function chooseCharacterMaterial(char) {
  characterMaterialTargetId.value = char?.id || null
  characterMaterialDialog.value = true
  characterMaterialInput.value?.click()
}

async function handleCharacterMaterialFile(event) {
  const input = event?.target
  const file = input?.files?.[0]
  input.value = ''
  const characterId = Number(characterMaterialTargetId.value)
  if (!file || !characterId) return
  if (!String(file.type || '').startsWith('image/')) {
    toast.error('请选择图片文件')
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toast.error('角色图片不能超过 10MB')
    return
  }

  uploadingCharacterImage.value = true
  try {
    await characterAPI.uploadImage(characterId, file)
    await refresh()
    toast.success('角色素材已上传并绑定')
  } catch (error) {
    toast.error(error?.message || '角色素材上传失败')
  } finally {
    uploadingCharacterImage.value = false
  }
}

function openVideoViewer(sb, title = '') {
  const src = mediaSrc(getDisplayShotVideoUrl(sb))
  if (!src) return
  videoViewer.value = { open: true, src, title }
}

function closeVideoViewer() {
  videoViewer.value = { open: false, src: '', title: '' }
}

function handleImageViewerKeydown(event) {
  if (event.key === 'Escape' && imageViewer.value.open) closeImageViewer()
  if (event.key === 'Escape' && videoViewer.value.open) closeVideoViewer()
}

onMounted(() => {
  window.addEventListener('keydown', handleImageViewerKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleImageViewerKeydown)
  if (videoSequenceTimer) clearInterval(videoSequenceTimer)
  if (mergeTimer) clearInterval(mergeTimer)
})

function isPendingSceneImage(id) {
  return pendingSceneImageIds.value.includes(id) || imageGenerations.value.some((generation) => {
    const sceneId = Number(generation?.scene_id || generation?.sceneId || 0)
    return sceneId === Number(id) && isImageGenerationPending(generation)
  })
}

function imageGenerationFor(kind, id) {
  const field = kind === 'character' ? 'character_id' : 'scene_id'
  return imageGenerations.value
    .filter(generation => Number(generation?.[field] || generation?.[toCamel(field)] || 0) === Number(id))
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] || null
}

function hasFailedImageGeneration(kind, id) {
  return String(imageGenerationFor(kind, id)?.status || '').toLowerCase() === 'failed'
}

function imageGenerationError(kind, id) {
  const generation = imageGenerationFor(kind, id)
  if (String(generation?.status || '').toLowerCase() !== 'failed') return ''
  return generation?.error_msg || generation?.errorMsg || '图片生成失败'
}

function imageBadgeClass(kind, id) {
  const generation = imageGenerationFor(kind, id)
  if (isPendingCharImage(id) && kind === 'character' || isPendingSceneImage(id) && kind === 'scene') return 'is-pending'
  if (String(generation?.status || '').toLowerCase() === 'failed') return 'is-failed'
  return kind === 'character'
    ? (chars.value.find(item => Number(item.id) === Number(id))?.image_url || chars.value.find(item => Number(item.id) === Number(id))?.imageUrl ? 'is-ready' : '')
    : (scenes.value.find(item => Number(item.id) === Number(id))?.image_url || scenes.value.find(item => Number(item.id) === Number(id))?.imageUrl ? 'is-ready' : '')
}

function imageBadgeLabel(kind, id, imagePathValue) {
  if (isPendingCharImage(id) && kind === 'character' || isPendingSceneImage(id) && kind === 'scene') return '生成中'
  if (hasFailedImageGeneration(kind, id)) return '生成失败'
  return imagePathValue ? '已生成' : '待生成'
}

async function retryOrGenerateImage(kind, id, generate) {
  const failed = imageGenerationFor(kind, id)
  if (!failed || String(failed.status || '').toLowerCase() !== 'failed') {
    await generate()
    return
  }
  try {
    if (kind === 'character' && !isPendingCharImage(id)) pendingCharImageIds.value.push(id)
    if (kind === 'scene' && !isPendingSceneImage(id)) pendingSceneImageIds.value.push(id)
    const entity = kind === 'character' ? chars.value.find(item => Number(item.id) === Number(id)) : scenes.value.find(item => Number(item.id) === Number(id))
    const previousPath = imagePath(entity?.image_url || entity?.imageUrl)
    const result = await imageAPI.retry(failed.id, { ...imageGenerationOptions.value, episode_id: epId.value })
    toast.success('已重新提交图片生成')
    await refresh()
    const generationId = Number(result?.id || 0)
    pollAssetImageGeneration({
      generationId,
      entityId: id,
      previousPath,
      getEntity: entityId => kind === 'character'
        ? chars.value.find(item => Number(item.id) === Number(entityId))
        : scenes.value.find(item => Number(item.id) === Number(entityId)),
      clearPending: entityId => {
        if (kind === 'character') pendingCharImageIds.value = pendingCharImageIds.value.filter(item => Number(item) !== Number(entityId))
        else pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => Number(item) !== Number(entityId))
      },
      failureMessage: kind === 'character' ? '角色设定稿生成失败' : '场景图片生成失败',
      timeoutMessage: kind === 'character' ? '角色设定稿生成超时' : '场景图片生成超时',
    })
  } catch (e) {
    if (kind === 'character') pendingCharImageIds.value = pendingCharImageIds.value.filter(item => Number(item) !== Number(id))
    else pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => Number(item) !== Number(id))
    toast.error(e.message)
  }
}

function isImageGenerationPending(generation) {
  return ['pending', 'queued', 'processing', 'running'].includes(String(generation?.status || '').trim().toLowerCase())
}

function framePendingKey(id, frameType) {
  return `${id}:${frameType}`
}

function isPendingShotFrame(id, frameType) {
  return pendingShotFrameKeys.value.includes(framePendingKey(id, frameType))
}

function isPendingVideo(id) {
  return pendingVideoIds.value.includes(id)
}

function isExportingVideo(sb) {
  const generation = exportableVideoGeneration(sb.id)
  return exportingVideoIds.value.includes(generation?.id || `storyboard:${sb.id}`)
}

function isPendingVolcAsset(key) {
  return pendingVolcAssetKeys.value.includes(key)
}

function isPendingTTS(id) {
  return pendingTTSIds.value.includes(id)
}

function ttsFailMessage(id) {
  return failedTTSMessages.value[id] || ''
}

function setTTSFailure(id, message) {
  failedTTSMessages.value = {
    ...failedTTSMessages.value,
    [id]: message || '配音生成失败',
  }
}

function clearTTSFailure(id) {
  if (!failedTTSMessages.value[id]) return
  const next = { ...failedTTSMessages.value }
  delete next[id]
  failedTTSMessages.value = next
}

function ttsStatusClass(sb) {
  if (isPendingTTS(sb.id)) return 'tag-info'
  if (ttsFailMessage(sb.id)) return 'tag-error'
  if (hasTTS(sb)) return 'tag-success'
  return ''
}

function ttsStatusLabel(sb) {
  if (isPendingTTS(sb.id)) return '生成中'
  if (ttsFailMessage(sb.id)) return '失败'
  if (hasTTS(sb)) return '已生成'
  return '待生成'
}

function videoFailMessage(id) {
  const latest = latestVideoGeneration(id)
  const status = String(latest?.status || '').toLowerCase()
  if (status === 'failed') return latest.error_msg || latest.errorMsg || '视频生成失败'
  if (status === 'completed') return ''
  return failedVideoMessages.value[id] || ''
}

function isPendingCompose(id) {
  return pendingComposeIds.value.includes(id)
}

function composeFailMessage(id) {
  return failedComposeMessages.value[id] || ''
}

function composeAudioStatusLabel(sb) {
  if (!dubbingEnabled.value) return '原声'
  if (composeAudioMode.value === 'original') return '原声'
  if (composeAudioMode.value === 'silent') return '静音'
  return hasTTS(sb) ? '配音' : '待配音'
}

function isNarratorCharacter(char) {
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  return text.includes('旁白') || text.includes('narrator') || text.includes('画外音')
}

const visualChars = computed(() => chars.value.filter(c => !isNarratorCharacter(c)))
const productionNeedsStoryboard = computed(() => !['chars', 'scenes'].includes(prodTab.value))

const lockedImageConfigId = computed(() => episode.value?.image_config_id || episode.value?.imageConfigId || null)
const lockedVideoConfigId = computed(() => episode.value?.video_config_id || episode.value?.videoConfigId || null)
const lockedAudioConfigId = computed(() => episode.value?.audio_config_id || episode.value?.audioConfigId || null)
const lockedImageConfigLabel = computed(() => configLabel(imageConfigs.value.find(c => c.id === lockedImageConfigId.value)))
const lockedVideoConfigLabel = computed(() => configLabel(videoConfigs.value.find(c => c.id === lockedVideoConfigId.value)))
const selectedImageOption = computed(() => parseGenerationOptionKey(selectedImageModelKey.value))
const selectedVideoOption = computed(() => parseGenerationOptionKey(selectedVideoModelKey.value))
const selectedAudioOption = computed(() => parseGenerationOptionKey(selectedAudioModelKey.value))
const effectiveImageConfigId = computed(() => resolveEffectiveGenerationConfigId(
  selectedImageOption.value.configId,
  lockedImageConfigId.value,
  activeImageConfigs.value,
))
const effectiveVideoConfigId = computed(() => resolveEffectiveGenerationConfigId(
  selectedVideoOption.value.configId,
  lockedVideoConfigId.value,
  activeVideoConfigs.value,
))
const effectiveAudioConfigId = computed(() => resolveEffectiveGenerationConfigId(
  selectedAudioOption.value.configId,
  lockedAudioConfigId.value,
  activeAudioConfigs.value,
))
const effectiveImageConfig = computed(() => activeImageConfigs.value.find(c => c.id === effectiveImageConfigId.value) || null)
const effectiveVideoConfig = computed(() => activeVideoConfigs.value.find(c => c.id === effectiveVideoConfigId.value) || null)
const effectiveAudioConfig = computed(() => activeAudioConfigs.value.find(c => c.id === effectiveAudioConfigId.value) || null)
const effectiveImageConfigLabel = computed(() => configLabel(effectiveImageConfig.value))
const effectiveVideoConfigLabel = computed(() => configLabel(effectiveVideoConfig.value))
const effectiveAudioConfigLabel = computed(() => configLabel(effectiveAudioConfig.value))
const effectiveImageModel = computed(() => selectedImageOption.value.model || firstConfigModel(effectiveImageConfig.value))
const isEggfansGptImage2C = computed(() =>
  String(effectiveImageConfig.value?.provider || '').trim().toLowerCase() === 'eggfans'
  && /^gpt-image-2-c$/i.test(String(effectiveImageModel.value || '').trim()),
)
const effectiveVideoModel = computed(() => selectedVideoOption.value.model || firstConfigModel(effectiveVideoConfig.value))
const effectiveAudioModel = computed(() => selectedAudioOption.value.model || firstConfigModel(effectiveAudioConfig.value))
const videoAspectRatioOptions = computed(() => {
  const provider = String(effectiveVideoConfig.value?.provider || '').trim().toLowerCase()
  const model = String(effectiveVideoModel.value || '').trim().toLowerCase()
  // xAI's native OpenAI-compatible adapter accepts the standard video ratios.
  // Eggfans' unified Grok route uses the 3:2/2:3 contract instead, so do not
  // let the provider name and model name accidentally override one another.
  if (provider === 'grok_openai') {
    return [
      { label: '横屏 · 16:9', value: '16:9' },
      { label: '竖屏 · 9:16', value: '9:16' },
  { label: '1x4', value: '1x4' },
      { label: '横屏 · 4:3', value: '4:3' },
      { label: '竖屏 · 3:4', value: '3:4' },
    ]
  }
  if (model.includes('grok-video') || model.includes('grok-imagine-video')) {
    return [
      { label: '横屏 · 3:2', value: '3:2' },
      { label: '竖屏 · 2:3', value: '2:3' },
  { label: '1x4', value: '1x4' },
    ]
  }
  return [
    { label: '横屏 · 16:9', value: '16:9' },
    { label: '竖屏 · 9:16', value: '9:16' },
  { label: '1x4', value: '1x4' },
    { label: '横屏 · 4:3', value: '4:3' },
    { label: '竖屏 · 3:4', value: '3:4' },
  ]
})
const storyboardAgentRuntimeLabel = computed(() => {
  const runtime = storyboardAgentRuntime.value
  const model = String(runtime?.model || '').trim()
  const provider = String(runtime?.provider || '').trim()
  if (model && provider) return `文本 Agent · ${model} (${provider})`
  if (model) return `文本 Agent · ${model}`
  return '后端文本 Agent'
})
const usesGrokPublicVideoReferences = computed(() =>
  String(effectiveVideoConfig.value?.provider || '').toLowerCase() === 'grok_openai'
  || isGrokVideoModelName(effectiveVideoModel.value),
)
const storyboardBreakdownMode = ref('standard')
const storyboardBreakdownModeOptions = [
  { label: '普通紧凑', value: 'standard' },
  { label: 'TK海外剧', value: 'tk_overseas' },
  { label: '3分钟内', value: 'grok_3min' },
  { label: '完整拆解', value: 'full' },
]
const storyboardBreakdownPolicy = computed(() => {
  if (storyboardBreakdownMode.value === 'tk_overseas') {
    return {
      mode: 'tk_overseas',
      shot_duration_min: 4,
      shot_duration_max: 15,
      min_total_duration: 60,
      max_total_duration: 100,
    }
  }
  if (usesGrokPublicVideoReferences.value && storyboardBreakdownMode.value === 'grok_3min') {
    return {
      mode: 'grok_3min',
      shot_duration: 10,
      max_total_duration: 180,
      max_shots: 18,
    }
  }
  return null
})
const storyboardBreakdownHint = computed(() => {
  if (storyboardBreakdownMode.value === 'tk_overseas') {
    const sceneCount = scenes.value.length
    const sceneScope = sceneCount
      ? `本集已提取 ${sceneCount} 个场景，将按剧本实际场景全部覆盖`
      : '场景数量将以本集剧本实际提取结果为准，不预设场景数量'
    return `TK海外剧：${sceneScope}；保留英文原台词和完整剧情，目标约60-90秒，最长可到100秒；镜头按实际节拍拆分，通常4-10秒，必要时可到15秒。`
  }
  if (storyboardBreakdownMode.value === 'grok_3min') return 'Grok 10s 版将压缩主线，最多18镜头，总时长控制在3分钟内。'
  if (storyboardBreakdownMode.value === 'standard') return '普通紧凑拆解：按叙事重点切镜，每镜4-7秒，不额外扩写剧情。'
  return '完整拆解会保留更多剧情细节，生成总时长可能超过3分钟。'
})
const usesVolcAssetVideoReferences = computed(() => {
  const provider = String(effectiveVideoConfig.value?.provider || '').toLowerCase()
  return provider === 'volcengine' && !usesGrokPublicVideoReferences.value
})
const usesSequentialVideo = computed(() => ['mijing', 'grok_openai'].includes(String(effectiveVideoConfig.value?.provider || '').toLowerCase()))
const sequenceProviderLabel = computed(() => String(effectiveVideoConfig.value?.provider || '').toLowerCase() === 'grok_openai' ? 'Grok Imagine ' : '谜镜 ')
const sequenceReferenceLimitLabel = computed(() => String(effectiveVideoConfig.value?.provider || '').toLowerCase() === 'grok_openai' ? '公网/base64参考上限 7 张' : '火山资产上限 9')
const sequenceAssetLimit = computed(() => String(effectiveVideoConfig.value?.provider || '').toLowerCase() === 'grok_openai' ? 7 : 9)
const sequenceBusy = computed(() => ['queued', 'running', 'paused'].includes(String(videoSequence.value?.status || '').toLowerCase()))
const sequenceCompletedCount = computed(() => Array.isArray(videoSequence.value?.steps) ? videoSequence.value.steps.filter(step => step.status === 'completed').length : 0)
const sequenceProgress = computed(() => {
  const total = Number(videoSequence.value?.total_count || videoSequence.value?.totalCount || sbs.value.length || 0)
  return total ? Math.min(100, Math.round(sequenceCompletedCount.value / total * 100)) : 0
})
const sequenceCurrentStep = computed(() => {
  const steps = Array.isArray(videoSequence.value?.steps) ? videoSequence.value.steps : []
  return steps.find(step => ['preparing', 'submitting', 'processing', 'extracting_tail'].includes(step.status))
    || steps.find(step => step.status === 'failed')
    || steps.find(step => step.status === 'pending')
    || null
})
const sequenceCurrentAssets = computed(() => {
  const raw = sequenceCurrentStep.value?.asset_refs || sequenceCurrentStep.value?.assetRefs
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
})
const imageGenerationOptions = computed(() => ({
  config_id: effectiveImageConfigId.value || undefined,
  model: effectiveImageModel.value || undefined,
  size: isEggfansGptImage2C.value ? selectedGptImage2CSize.value : undefined,
  breakdown_mode: storyboardBreakdownMode.value,
}))
const videoGenerationOptions = computed(() => ({
  config_id: effectiveVideoConfigId.value || undefined,
  model: effectiveVideoModel.value || undefined,
  aspect_ratio: selectedVideoAspectRatio.value,
}))
const audioGenerationOptions = computed(() => ({
  config_id: effectiveAudioConfigId.value || undefined,
  model: effectiveAudioModel.value || undefined,
}))

watch([lockedImageConfigId, imageConfigs], () => {
  const options = imageConfigSelectOptions.value
  if (!options.length) {
    selectedImageModelKey.value = ''
    return
  }
  if (!options.some(option => option.value === selectedImageModelKey.value)) {
    const lockedOption = lockedImageConfigId.value
      ? options.find(option => parseGenerationOptionKey(option.value).configId === lockedImageConfigId.value)
      : null
    selectedImageModelKey.value = lockedOption?.value || options[0].value
  }
}, { immediate: true })

watch([lockedVideoConfigId, videoConfigs], () => {
  const options = videoConfigSelectOptions.value
  if (!options.length) {
    selectedVideoModelKey.value = ''
    return
  }
  if (!options.some(option => option.value === selectedVideoModelKey.value)) {
    const lockedOption = lockedVideoConfigId.value
      ? options.find(option => parseGenerationOptionKey(option.value).configId === lockedVideoConfigId.value)
      : null
    selectedVideoModelKey.value = lockedOption?.value || options[0].value
  }
}, { immediate: true })

watch(usesGrokPublicVideoReferences, (enabled) => {
  if (enabled && ['standard'].includes(storyboardBreakdownMode.value)) {
    storyboardBreakdownMode.value = 'grok_3min'
  } else if (!enabled && storyboardBreakdownMode.value === 'grok_3min') {
    storyboardBreakdownMode.value = 'standard'
  }
}, { immediate: true })

watch(videoAspectRatioOptions, (options) => {
  if (!options.some(option => option.value === selectedVideoAspectRatio.value)) {
    selectedVideoAspectRatio.value = options[0]?.value || '16:9'
  }
}, { immediate: true })

watch([lockedAudioConfigId, audioConfigs], () => {
  const options = audioConfigSelectOptions.value
  if (!options.length) {
    selectedAudioModelKey.value = ''
    return
  }
  if (!options.some(option => option.value === selectedAudioModelKey.value)) {
    const lockedOption = lockedAudioConfigId.value
      ? options.find(option => parseGenerationOptionKey(option.value).configId === lockedAudioConfigId.value)
      : null
    selectedAudioModelKey.value = lockedOption?.value || options[0].value
  }
}, { immediate: true })

function savedModelOption(options, value) {
  const candidate = String(value || '')
  return options.some(option => option.value === candidate) ? candidate : ''
}

async function restoreModelPreferences() {
  let saved = null
  try {
    const stored = await preferenceAPI.get(modelPreferenceKey)
    saved = stored?.selectedModels || null
  } catch (error) {
    console.warn('Failed to load saved model selections', error)
  }

  if (!saved && typeof window !== 'undefined') {
    try {
      const legacy = JSON.parse(window.localStorage.getItem(modelPreferenceKey) || '{}')
      saved = legacy?.selectedModels || null
    } catch {}
  }

  if (saved && typeof saved === 'object') {
    const image = savedModelOption(imageConfigSelectOptions.value, saved.image)
    const video = savedModelOption(videoConfigSelectOptions.value, saved.video)
    const audio = savedModelOption(audioConfigSelectOptions.value, saved.audio)
    if (image) selectedImageModelKey.value = image
    if (video) selectedVideoModelKey.value = video
    if (audio) selectedAudioModelKey.value = audio
  }
  try {
    const storedRatio = await preferenceAPI.get(videoAspectRatioPreferenceKey)
    const ratio = String(storedRatio?.value || storedRatio || '').trim()
    if (videoAspectRatioOptions.value.some(option => option.value === ratio)) selectedVideoAspectRatio.value = ratio
  } catch {}
  modelPreferencesHydrated = true
  persistModelPreferences()
}

function persistModelPreferences() {
  const selectedModels = {
    image: selectedImageModelKey.value,
    video: selectedVideoModelKey.value,
    audio: selectedAudioModelKey.value,
  }
  if (typeof window !== 'undefined') {
    try {
      const current = JSON.parse(window.localStorage.getItem(modelPreferenceKey) || '{}')
      window.localStorage.setItem(modelPreferenceKey, JSON.stringify({ ...current, selectedModels }))
    } catch {}
  }
  if (!modelPreferencesHydrated) return
  modelPreferenceSave = modelPreferenceSave
    .catch(() => undefined)
    .then(() => preferenceAPI.set(modelPreferenceKey, { selectedModels }))
    .catch((error) => console.warn('Failed to save selected model', error))
}

watch([selectedImageModelKey, selectedVideoModelKey, selectedAudioModelKey], persistModelPreferences)
watch(selectedVideoAspectRatio, (value) => {
  const ratio = String(value || '').trim()
  if (!ratio) return
  try { window.localStorage.setItem(videoAspectRatioPreferenceKey, ratio) } catch {}
  preferenceAPI.set(videoAspectRatioPreferenceKey, ratio).catch(() => undefined)
})

// Grid tool state
const gridDialog = ref(false)
const gridStep = ref(0)
const gridLayout = ref('3x3')
const gridMode = ref('first_frame')
const gridSelected = ref([])
const gridSingleTarget = ref(null)
const gridGenId = ref(null)
const gridImagePath = ref('')
const gridStatusText = ref('')
const gridActualLayout = ref({ rows: 3, cols: 3 })
const gridRecoveredAt = ref('')
const gridRecoveredMode = ref('')
const gridPromptText = ref('')
const gridCellPrompts = ref([])
const gridPromptSource = ref('')
const gridPromptLoading = ref(false)
const gridPromptStatus = ref('')
const gridAssignmentsState = ref([])
const gridActiveShotIds = ref([])
const gridHistory = ref([])
const allGridHistory = ref([])
const showAllGridHistory = ref(false)
const activeGridCell = ref(0)
const gridAssignmentPage = ref(0)
const activeGridStoryboardId = computed(() => {
  if (gridDialog.value && gridMode.value === 'multi_ref') return gridSingleTarget.value || selectedSb.value?.id || null
  if (frameMode.value === 'multi_ref') return selectedSb.value?.id || gridSingleTarget.value || null
  return null
})
const gridStorageKey = computed(() => {
  const scope = activeGridStoryboardId.value ? `storyboard:${activeGridStoryboardId.value}` : 'episode'
  return `eggfans:grid:${dramaId}:${epId.value || episodeNumber}:${scope}`
})

const gridModes = [
  { id: 'first_frame', label: '首帧', desc: '每格=一个镜头的首帧' },
  { id: 'first_last', label: '首尾帧', desc: '按所选宫格生成首尾帧参考' },
  { id: 'multi_ref', label: '多参考', desc: '所有格子=同一镜头的参考图' },
]

const gridLayoutShape = computed(() => {
  const [rows, cols] = String(gridLayout.value || '3x3').split('x').map(Number)
  return {
    rows: rows || 3,
    cols: cols || 3,
  }
})
const gridTotalCells = computed(() => {
  return gridLayoutShape.value.rows * gridLayoutShape.value.cols
})

const gridCanStart = computed(() => {
  if (gridMode.value === 'multi_ref') return !!gridSingleTarget.value
  return gridSelected.value.length > 0
})

const gridSummary = computed(() => {
  if (gridMode.value === 'multi_ref') {
    const idx = sbs.value.findIndex(s => s.id === gridSingleTarget.value) + 1
    return gridSingleTarget.value ? `${gridLayoutShape.value.rows}x${gridLayoutShape.value.cols} 参考图 → 镜头 #${idx}` : '请选择一个镜头'
  }
  if (!gridSelected.value.length) return '请选择镜头'
  const count = gridSelected.value.length
  if (gridMode.value === 'first_last') {
    const { rows, cols } = gridLayoutShape.value
    return `${count} 个镜头 → ${rows}x${cols} 宫格（按首尾帧风格生成，切分后再手动分配）`
  }
  const { rows, cols } = gridLayoutShape.value
  const cells = rows * cols
  return `${count} 个镜头 → ${rows}x${cols} 宫格（先生成宫格图，切分后再手动分配）`
})

function createGridAssignments() {
  const defaultFrameType = gridMode.value === 'multi_ref'
    ? 'reference'
    : 'first_frame'
  const defaultStoryboardId = gridMode.value === 'multi_ref' && gridSingleTarget.value
    ? gridSingleTarget.value
    : null
  return normalizeGridAssignments([], gridActualLayout.value, {
    storyboard_id: defaultStoryboardId,
    frame_type: defaultFrameType,
  })
}

function createGridAssignmentsForActiveShots(shotIds = gridActiveShotIds.value) {
  const defaultFrameType = gridMode.value === 'multi_ref'
    ? 'reference'
    : 'first_frame'
  if (gridMode.value === 'multi_ref' && gridSingleTarget.value) {
    return normalizeGridAssignments([], gridActualLayout.value, {
      storyboard_id: gridSingleTarget.value,
      frame_type: 'reference',
    })
  }
  return createGridAssignmentsForShots(shotIds, gridActualLayout.value, defaultFrameType)
}

const gridAssignments = computed(() => gridAssignmentsState.value)
const gridAssignableShotIds = computed(() => {
  const assignedIds = [...new Set(gridAssignments.value.map(item => item?.storyboard_id).filter(Boolean))]
  const ids = Array.isArray(gridActiveShotIds.value) && gridActiveShotIds.value.length
    ? gridActiveShotIds.value
    : assignedIds.length
      ? assignedIds
    : gridMode.value === 'multi_ref'
      ? (gridSingleTarget.value ? [gridSingleTarget.value] : [])
      : gridSelected.value.length
        ? [...gridSelected.value]
        : sbs.value.map(s => s.id)
  return ids.filter(id => sbs.value.some(s => s.id === id))
})
const gridAssignmentShotOptions = computed(() => [
  { label: '未分配', value: null },
  ...gridAssignableShotIds.value.map((id) => {
    const index = sbs.value.findIndex(s => s.id === id) + 1
    const sb = sbs.value.find(s => s.id === id)
    return {
      label: `#${String(index).padStart(2, '0')} ${sb?.title || sb?.description || '镜头'}`,
      value: id,
    }
  }),
])
const gridFrameTypeOptions = computed(() => {
  return [
    { label: '首帧', value: 'first_frame' },
    { label: '尾帧', value: 'last_frame' },
    { label: '参考图', value: 'reference' },
  ]
})
const gridAssignedCount = computed(() => gridAssignments.value.filter(item => !!item.storyboard_id).length)
const gridAssignmentPageSize = computed(() => {
  if (gridAssignments.value.length >= 25) return 8
  if (gridAssignments.value.length >= 16) return 10
  if (gridAssignments.value.length >= 9) return 9
  return Math.max(1, gridAssignments.value.length || 1)
})
const gridAssignmentTotalPages = computed(() => Math.max(1, Math.ceil(gridAssignments.value.length / gridAssignmentPageSize.value)))
const gridAssignmentPageStart = computed(() => gridAssignmentPage.value * gridAssignmentPageSize.value)
const gridAssignmentPageEnd = computed(() => Math.min(gridAssignments.value.length, gridAssignmentPageStart.value + gridAssignmentPageSize.value))
const pagedGridAssignments = computed(() => {
  return gridAssignments.value
    .slice(gridAssignmentPageStart.value, gridAssignmentPageEnd.value)
    .map((assignment, offset) => ({
      assignment,
      index: gridAssignmentPageStart.value + offset,
    }))
})

function resetGridAssignments() {
  gridAssignmentsState.value = gridActiveShotIds.value.length
    ? createGridAssignmentsForActiveShots()
    : createGridAssignments()
  activeGridCell.value = 0
  gridAssignmentPage.value = 0
}

function gridCellLabel(a) {
  if (!a?.storyboard_id) return '未分配'
  const idx = sbs.value.findIndex(s => s.id === a.storyboard_id) + 1
  const suffix = { first_frame: '首', last_frame: '尾', reference: '参' }[a.frame_type] || ''
  return `#${idx}${suffix ? ` ${suffix}` : ''}`
}

function gridCellTitle(id) {
  if (!id) return '未分配'
  const idx = sbs.value.findIndex(s => s.id === id) + 1
  const sb = sbs.value.find(s => s.id === id)
  return `#${String(idx).padStart(2, '0')} ${sb?.title || sb?.description || '镜头'}`
}

function gridModeLabel(frameType) {
  const layoutless = gridModeFromFrameType(frameType)
  const labels = {
    first_frame: '批量首帧',
    first_last: '批量首尾帧',
    multi_ref: '多参考图',
  }
  return labels[layoutless] || layoutless.replace(/_/g, ' · ') || '宫格图'
}

function gridModeFromFrameType(frameType) {
  return String(frameType || '').replace(/^grid_/, '').replace(/_\d+x\d+$/, '')
}

function inferGridShotIds(row) {
  const storyboardId = Number(row?.storyboard_id || row?.storyboardId || 0) || null
  if (storyboardId) return [storyboardId]
  const prompt = String(row?.prompt || '')
  if (!prompt) return []

  const inferred = sbs.value
    .filter((sb) => {
      const candidates = [
        sb.title,
        sb.description,
        sb.image_prompt || sb.imagePrompt,
      ]
        .map(value => String(value || '').trim())
        .filter(Boolean)
      return candidates.some((candidate) => prompt.includes(candidate))
    })
    .sort((a, b) => Number(a.storyboard_number || a.storyboardNumber || 0) - Number(b.storyboard_number || b.storyboardNumber || 0))
    .map(sb => sb.id)
  const layout = parseGridLayoutFromFrameType(row?.frame_type || row?.frameType)
  return layout ? inferred.slice(0, layout.rows * layout.cols) : inferred
}

function gridTargetLabel(item) {
  const ids = Array.isArray(item?.shotIds) ? item.shotIds : []
  if (!ids.length) return '未绑定镜头'
  const nums = ids
    .map((id) => sbs.value.findIndex(sb => Number(sb.id) === Number(id)) + 1)
    .filter(index => index > 0)
  if (!nums.length) return '未绑定镜头'
  if (nums.length === 1) return `镜头 #${String(nums[0]).padStart(2, '0')}`
  return `镜头 #${String(nums[0]).padStart(2, '0')}-#${String(nums[nums.length - 1]).padStart(2, '0')}`
}

function toGridHistoryItem(row) {
  const frameType = String(row?.frame_type || row?.frameType || '')
  const parsedLayout = parseGridLayoutFromFrameType(frameType) || { rows: 3, cols: 3 }
  const storyboardId = Number(row?.storyboard_id || row?.storyboardId || 0) || null
  const shotIds = inferGridShotIds(row)
  const mode = gridModeFromFrameType(frameType)
  const frameTypeForCells = mode === 'multi_ref' ? 'reference' : 'first_frame'
  const item = {
    id: row.id,
    storyboardId,
    localPath: row?.local_path || row?.localPath || '',
    layout: parsedLayout,
    shotIds,
    modeLabel: gridModeLabel(frameType),
    mode,
    frameType,
    assignments: createGridAssignmentsForShots(shotIds, parsedLayout, frameTypeForCells),
    createdAtLabel: row?.created_at || row?.createdAt || '',
  }
  return {
    ...item,
    targetLabel: gridTargetLabel(item),
  }
}

function updateGridAssignment(index, field, value) {
  const next = [...gridAssignmentsState.value]
  next[index] = { ...next[index], [field]: value }
  gridAssignmentsState.value = next
  activeGridCell.value = index
  if (gridImagePath.value) persistGridImagePath(gridImagePath.value)
}

function focusGridCell(index) {
  activeGridCell.value = index
  gridAssignmentPage.value = Math.floor(index / gridAssignmentPageSize.value)
}

const gridOverlayStyle = computed(() => {
  const { rows, cols } = gridActualLayout.value
  return { 'grid-template-columns': `repeat(${cols}, 1fr)`, 'grid-template-rows': `repeat(${rows}, 1fr)` }
})

const gridAutoLayout = computed(() => {
  return gridLayoutShape.value
})

const gridBlankStyle = computed(() => {
  const { rows, cols } = gridAutoLayout.value
  return { 'grid-template-columns': `repeat(${cols}, 1fr)`, 'grid-template-rows': `repeat(${rows}, 1fr)` }
})

// Production step helpers
function prodStepDone(id) {
  if (id === 'chars') return !visualCharTotal.value || charImgCount.value === visualCharTotal.value
  if (id === 'scenes') return !!scenes.value.length && sceneImgCount.value === scenes.value.length
  if (id === 'dubbing') return !dubbingEnabled.value || (!!sbs.value.length && isDubbingReady.value)
  if (id === 'shots') return !!sbs.value.length && shotImgCount.value === sbs.value.length
  if (id === 'videos') return !!sbs.value.length && shotVidCount.value === sbs.value.length
  if (id === 'compose') return mergeCandidateCount.value > 0 && composedCount.value === mergeCandidateCount.value
  return false
}
const canExport = computed(() => mergeCandidateCount.value > 0 && composedCount.value === mergeCandidateCount.value)
function goNextProd() {
  if (prodTabIdx.value < prodTabDefs.value.length - 1) {
    prodTabIdx.value++
  } else {
    panel.value = 'export'
  }
}

// Script step navigation
const stepLabels = ['原始内容', 'AI 改写', '提取', '音色', '分镜']
const prevStepLabel = computed(() => {
  if (scriptStep.value === 4 && !dubbingEnabled.value) return stepLabels[2]
  if (scriptStep.value > 0) return stepLabels[scriptStep.value - 1]
  return ''
})
const nextStepLabel = computed(() => {
  if (scriptStep.value === 4) return '进入制作'
  if (scriptStep.value === 2 && !dubbingEnabled.value) return stepLabels[4]
  return stepLabels[scriptStep.value + 1] || ''
})
const canGoNext = computed(() => {
  if (scriptStep.value === 0) return !!localRaw.value.trim()
  if (scriptStep.value === 1) return !!localScript.value.trim() || !!scriptContent.value
  if (scriptStep.value === 2) return hasExtractedAssets.value
  if (scriptStep.value === 3) return dubbingEnabled.value && charsVoiced.value > 0
  if (scriptStep.value === 4) return sbs.value.length > 0
  return false
})
function goPrevStep() {
  if (scriptStep.value <= 0) return
  if (scriptStep.value === 4 && !dubbingEnabled.value) scriptStep.value = 2
  else scriptStep.value--
}
function goNextStep() {
  if (scriptStep.value === 0 && localRaw.value.trim()) { saveRaw() }
  if (scriptStep.value === 1 && localScript.value.trim()) { saveScr() }
  if (scriptStep.value === 4) { panel.value = 'production'; return }
  if (!canGoNext.value) return
  if (scriptStep.value === 2 && !dubbingEnabled.value) scriptStep.value = 4
  else scriptStep.value++
}

function gridSelectAll() {
  if (gridSelected.value.length === sbs.value.length) gridSelected.value = []
  else gridSelected.value = sbs.value.map(s => s.id)
}

function openGridTool() {
  gridStep.value = 0
  if (frameMode.value === 'multi_ref') {
    gridMode.value = 'multi_ref'
    if (gridLayout.value === '3x3') gridLayout.value = '2x2'
  }
  gridSelected.value = []
  gridSingleTarget.value = frameMode.value === 'multi_ref'
    ? selectedSb.value?.id || sbs.value[0]?.id || null
    : null
  gridActiveShotIds.value = []
  gridPromptText.value = ''
  gridCellPrompts.value = []
  gridPromptSource.value = ''
  gridPromptStatus.value = ''
  gridStatusText.value = ''
  gridAssignmentsState.value = []
  gridDialog.value = true
}

function openGridToolForReference(sb) {
  selectedSb.value = sb
  frameMode.value = 'multi_ref'
  gridMode.value = 'multi_ref'
  openGridTool()
}

function persistGridImagePath(value) {
  if (typeof window === 'undefined') return
  if (!value) {
    window.localStorage.removeItem(gridStorageKey.value)
    return
  }
  const current = restoreGridState() || {}
  const entries = current.entries || {}
  entries[value] = {
    generationId: gridGenId.value,
    storyboardId: activeGridStoryboardId.value,
    layout: gridActualLayout.value,
    shotIds: gridActiveShotIds.value,
    assignments: gridAssignmentsState.value,
    recoveredAt: gridRecoveredAt.value,
    recoveredMode: gridRecoveredMode.value,
  }
  const payload = {
    activeImagePath: value,
    entries,
  }
  window.localStorage.setItem(gridStorageKey.value, JSON.stringify(payload))
}

function restoreGridState() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(gridStorageKey.value)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return { activeImagePath: raw, entries: { [raw]: {} } }
  }
}

function applyGridState(imagePath, meta = {}) {
  gridImagePath.value = imagePath || ''
  gridGenId.value = meta.generationId || meta.id || null
  if (meta.mode) gridMode.value = meta.mode
  if (meta.storyboardId && gridMode.value === 'multi_ref') gridSingleTarget.value = meta.storyboardId
  if (meta.layout?.rows && meta.layout?.cols) gridActualLayout.value = meta.layout
  if (Array.isArray(meta.shotIds)) gridActiveShotIds.value = meta.shotIds
  else gridActiveShotIds.value = []
  if (Array.isArray(meta.assignments)) gridAssignmentsState.value = normalizeGridAssignments(meta.assignments, gridActualLayout.value, {
    storyboard_id: gridMode.value === 'multi_ref' ? (meta.storyboardId || gridSingleTarget.value || null) : null,
    frame_type: gridMode.value === 'multi_ref' ? 'reference' : 'first_frame',
  })
  else if (gridActiveShotIds.value.length) gridAssignmentsState.value = createGridAssignmentsForActiveShots()
  else gridAssignmentsState.value = []
  gridRecoveredAt.value = meta.recoveredAt || meta.createdAtLabel || ''
  gridRecoveredMode.value = meta.recoveredMode || meta.modeLabel || ''
}

function clearGridState() {
  gridImagePath.value = ''
  gridGenId.value = null
  gridRecoveredAt.value = ''
  gridRecoveredMode.value = ''
  gridAssignmentsState.value = []
  gridActiveShotIds.value = []
}

function isGridHistoryItemInCurrentScope(item) {
  const targetStoryboardId = activeGridStoryboardId.value ? Number(activeGridStoryboardId.value) : null
  if (targetStoryboardId) return Number(item.storyboardId || 0) === targetStoryboardId
  return !Number(item.storyboardId || 0)
}

function selectGridHistory(item) {
  const cached = restoreGridState()
  const cachedEntry = cached?.entries?.[item.localPath] || {}
  applyGridState(item.localPath, {
    ...item,
    ...cachedEntry,
    generationId: cachedEntry.generationId || item.id,
    shotIds: Array.isArray(cachedEntry.shotIds) && cachedEntry.shotIds.length ? cachedEntry.shotIds : item.shotIds,
    assignments: Array.isArray(cachedEntry.assignments) && cachedEntry.assignments.length ? cachedEntry.assignments : item.assignments,
    recoveredAt: cachedEntry.recoveredAt || item.createdAtLabel,
    recoveredMode: cachedEntry.recoveredMode || item.modeLabel,
  })
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  persistGridImagePath(item.localPath)
}

function reopenGridPreview() {
  if (!gridImagePath.value) {
    openGridTool()
    return
  }
  gridDialog.value = true
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  gridStep.value = 3
}

function continueGridSplit() {
  if (!gridImagePath.value) {
    toast.warning('还没有可继续切割的宫格图')
    return
  }
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  gridDialog.value = true
  gridStep.value = 3
}

function getGridPromptShotIds() {
  if (gridMode.value === 'multi_ref') return gridSingleTarget.value ? [gridSingleTarget.value] : []
  if (gridMode.value === 'first_last') return [...gridSelected.value]
  return gridSelected.value.slice(0, gridTotalCells.value)
}

async function generateGridPrompt() {
  if (!gridCanStart.value) {
    toast.warning('请先选择镜头')
    return
  }
  gridPromptLoading.value = true
  gridPromptStatus.value = '正在调用 AI 生成宫格提示词...'
  gridPromptText.value = ''
  gridCellPrompts.value = []
  gridPromptSource.value = ''
  try {
    const shotIds = getGridPromptShotIds()
    const { rows, cols } = gridAutoLayout.value
    gridActiveShotIds.value = shotIds.filter(Boolean)
    gridActualLayout.value = { rows, cols }

    const res = await gridAPI.prompt({
      storyboard_ids: shotIds,
      drama_id: dramaId,
      episode_id: epId.value,
      rows,
      cols,
      mode: gridMode.value,
    })

    gridPromptText.value = res?.grid_prompt || ''
    gridCellPrompts.value = Array.isArray(res?.cell_prompts) ? res.cell_prompts : []
    gridPromptSource.value = res?.source || ''

    if (gridPromptText.value) {
      resetGridAssignments()
      gridPromptStatus.value = gridPromptSource.value === 'agent' ? 'AI 提示词已生成' : '已使用模板提示词'
      gridStep.value = 1
    } else {
      gridPromptStatus.value = ''
      toast.error('提示词生成失败')
    }
  } catch (e) {
    gridPromptStatus.value = ''
    toast.error(e?.message || '生成提示词失败')
  } finally {
    gridPromptLoading.value = false
  }
}

async function startGridGen() {
  let rows, cols, ids
  if (gridMode.value === 'multi_ref') {
    rows = gridAutoLayout.value.rows; cols = gridAutoLayout.value.cols; ids = [gridSingleTarget.value]
  } else {
    rows = gridAutoLayout.value.rows; cols = gridAutoLayout.value.cols; ids = gridSelected.value.slice(0, gridTotalCells.value)
    if (gridMode.value === 'first_last') ids = [...gridSelected.value]
  }
  gridActiveShotIds.value = ids.filter(Boolean)
  gridActualLayout.value = { rows, cols }
  resetGridAssignments()
  gridStep.value = 2
  gridStatusText.value = '提交生成请求...'
  try {
    const res = await gridAPI.generate({
      storyboard_ids: ids,
      drama_id: dramaId,
      episode_id: epId.value,
      config_id: effectiveImageConfigId.value || undefined,
      model: effectiveImageModel.value || undefined,
      size: isEggfansGptImage2C.value ? selectedGptImage2CSize.value : undefined,
      rows,
      cols,
      mode: gridMode.value,
      custom_prompt: gridPromptText.value || undefined,
    })
    gridGenId.value = res.image_generation_id
    const responseStoryboardId = res.storyboard_id || res.storyboardId
    if (responseStoryboardId) {
      const current = sbs.value.find(sb => Number(sb.id) === Number(responseStoryboardId))
      if (current) selectedSb.value = current
      gridSingleTarget.value = Number(responseStoryboardId)
    }
    gridActualLayout.value = res.grid || { rows, cols }
    gridStatusText.value = '等待图片生成...'
    pollGridStatus()
  } catch (e) {
    toast.error(e.message)
    gridStep.value = 1
  }
}

async function pollGridStatus() {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const res = await gridAPI.status(gridGenId.value)
      gridStatusText.value = `状态: ${res.status}`
      const responseMode = res.mode || gridModeFromFrameType(res.frame_type || res.frameType)
      if (responseMode) gridMode.value = responseMode
      const statusLayout = res.grid || parseGridLayoutFromFrameType(res.frame_type || res.frameType)
      if (statusLayout?.rows && statusLayout?.cols) {
        gridActualLayout.value = statusLayout
        gridAssignmentsState.value = normalizeGridAssignments(gridAssignmentsState.value, gridActualLayout.value, {
          frame_type: gridMode.value === 'multi_ref' ? 'reference' : 'first_frame',
        })
      }
      if (res.status === 'completed' && res.local_path) {
        gridImagePath.value = res.local_path
        gridGenId.value = gridGenId.value || res.id || null
        const responseStoryboardId = Number(res.storyboard_id || res.storyboardId || 0) || null
        if (responseStoryboardId) gridSingleTarget.value = responseStoryboardId
        persistGridImagePath(res.local_path)
        await loadLatestGridImage()
        gridStep.value = 3
        return
      }
      if (res.status === 'failed') {
        gridStatusText.value = res.error_msg || '生成失败'
        toast.error(gridStatusText.value)
        gridStep.value = 1
        return
      }
    } catch {}
  }
  gridStatusText.value = '生成超时'
  toast.error('生成超时'); gridStep.value = 1
}

async function loadLatestGridImage() {
  try {
    const rows = await imageAPI.list({ drama_id: dramaId })
    const list = Array.isArray(rows) ? rows : []
    const allGrids = list
      .filter((row) => row?.status === 'completed' && String(row?.frame_type || row?.frameType || '').startsWith('grid_') && (row?.local_path || row?.localPath))
      .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))
      .map(toGridHistoryItem)
    const grids = allGrids.filter(isGridHistoryItemInCurrentScope)

    gridHistory.value = grids
    allGridHistory.value = allGrids

    const cached = restoreGridState()
    const preferredPath = cached?.activeImagePath && grids.some(item => item.localPath === cached.activeImagePath)
      ? cached.activeImagePath
      : grids[0]?.localPath
    const current = grids.find(item => item.localPath === preferredPath)
    if (current) {
      const cachedEntry = cached?.entries?.[current.localPath] || {}
      applyGridState(current.localPath, {
        ...current,
        ...cachedEntry,
        generationId: cachedEntry.generationId || current.id,
        shotIds: Array.isArray(cachedEntry.shotIds) && cachedEntry.shotIds.length ? cachedEntry.shotIds : current.shotIds,
        assignments: Array.isArray(cachedEntry.assignments) && cachedEntry.assignments.length ? cachedEntry.assignments : current.assignments,
        recoveredAt: cachedEntry.recoveredAt || current.createdAtLabel,
        recoveredMode: cachedEntry.recoveredMode || current.modeLabel,
      })
      if (!gridAssignmentsState.value.length) resetGridAssignments()
      persistGridImagePath(current.localPath)
      return
    }

    clearGridState()
    return
  } catch {}

  const cached = restoreGridState()
  if (cached?.activeImagePath) {
    const cachedEntry = cached?.entries?.[cached.activeImagePath] || {}
    applyGridState(cached.activeImagePath, {
      ...cachedEntry,
      recoveredAt: cachedEntry.recoveredAt || '',
      recoveredMode: cachedEntry.recoveredMode || '',
    })
  }
}

async function doGridSplit() {
  const { rows, cols } = gridActualLayout.value
  try {
    const assignments = gridAssignments.value
      .filter(item => !!item.storyboard_id)
      .map(item => ({ storyboard_id: item.storyboard_id, frame_type: item.frame_type }))
    if (!assignments.length) {
      toast.warning('请至少分配一个格子')
      return
    }
    const res = await gridAPI.split({ image_generation_id: gridGenId.value, rows, cols, assignments })
    persistGridImagePath(gridImagePath.value)
    if (Array.isArray(res?.storyboards)) {
      for (const item of res.storyboards) {
        const target = sbs.value.find(sb => Number(sb.id) === Number(item.id || item.storyboard_id || item.storyboardId))
        if (!target) continue
        target.reference_images = JSON.stringify(item.reference_images || item.referenceImages || [])
        target.referenceImages = target.reference_images
      }
    }
    await refresh()
    gridStep.value = 4
    toast.success('切分分配完成')
  } catch (e) {
    toast.error(e.message)
  }
}

const charImgCount = computed(() => visualChars.value.filter(c => c.image_url || c.imageUrl).length)
const sceneImgCount = computed(() => scenes.value.filter(s => s.image_url || s.imageUrl).length)
const ttsEligibleCount = computed(() => sbs.value.filter(s => hasDialogue(s)).length)
const ttsGeneratedCount = computed(() => sbs.value.filter(s => hasDialogue(s) && hasTTS(s)).length)
const ttsPendingCount = computed(() => sbs.value.filter(s => hasDialogue(s) && !hasTTS(s) && !isPendingTTS(s.id)).length)
const isDubbingRequired = computed(() => dubbingEnabled.value && composeAudioMode.value === 'tts')
const isDubbingReady = computed(() => !isDubbingRequired.value || !ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value)
const shotImgCount = computed(() => sbs.value.filter(s => hasVideoReferenceInput(s)).length)
const shotFirstFrameCount = computed(() => sbs.value.filter(s => getFirstFrame(s)).length)
const shotLastFrameCount = computed(() => sbs.value.filter(s => getLastFrame(s)).length)
const shotReferenceCount = computed(() => sbs.value.filter(s => getRefs(s).length).length)
const missingFirstFrameShots = computed(() => sbs.value.filter(s => !getFirstFrame(s) && !isPendingShotFrame(s.id, 'first_frame')))
const missingLastFrameShots = computed(() => sbs.value.filter(s => !getLastFrame(s) && !isPendingShotFrame(s.id, 'last_frame')))
const missingShotFramePairs = computed(() => {
  return sbs.value.filter(s => (!getFirstFrame(s) && !isPendingShotFrame(s.id, 'first_frame')) || (!getLastFrame(s) && !isPendingShotFrame(s.id, 'last_frame')))
})
const shotVidCount = computed(() => sbs.value.filter(s => hasVid(s)).length)
const grokVideoReferenceReadyCount = computed(() => sbs.value.filter(sb => getGrokVideoReferenceItems(sb).length > 0).length)
const batchVideoTargets = computed(() => {
  const available = sbs.value.filter(sb => !isPendingVideo(sb.id) && !isBackendVideoProcessing(sb.id))
  const missing = available.filter(sb => !hasVid(sb))
  return missing.length ? missing : available.filter(sb => hasVid(sb))
})
const batchVideoTargetCount = computed(() => batchVideoTargets.value.length)
const isBatchVideoRegenerate = computed(() => !!sbs.value.length && !sbs.value.some(sb => !hasVid(sb)) && batchVideoTargetCount.value > 0)
const batchVideoButtonLabel = computed(() => isBatchVideoRegenerate.value ? '批量重生成' : '批量视频')
const volcReferenceStats = computed(() => {
  const refs = allVolcReferenceItems.value
  const uploaded = refs.filter(ref => ref.asset).length
  return { total: refs.length, uploaded, missing: refs.length - uploaded }
})
const characterVolcStats = computed(() => {
  const refs = allCharacterVolcAssetItems.value
  const uploaded = refs.filter(ref => ref.asset).length
  return { total: refs.length, uploaded, missing: refs.length - uploaded }
})
const sceneVolcStats = computed(() => {
  const refs = allSceneVolcAssetItems.value
  const uploaded = refs.filter(ref => ref.asset).length
  return { total: refs.length, uploaded, missing: refs.length - uploaded }
})
const visualCharTotal = computed(() => visualChars.value.length)

const prodTabDefs = computed(() => [
  { id: 'chars', label: '角色设定稿', icon: Users, badge: visualCharTotal.value ? `${charImgCount.value}/${visualCharTotal.value}` : '' },
  { id: 'scenes', label: '场景图片', icon: MapPin, badge: sceneImgCount.value ? `${sceneImgCount.value}/${scenes.value.length}` : '' },
  ...(dubbingEnabled.value ? [{ id: 'dubbing', label: '配音生成', icon: Mic2, badge: '' }] : []),
  { id: 'shots', label: '镜头图片', icon: ImageIcon, badge: shotImgCount.value ? `${shotImgCount.value}/${sbs.value.length}` : '' },
  { id: 'videos', label: '视频生成', icon: Video, badge: shotVidCount.value ? `${shotVidCount.value}/${sbs.value.length}` : '' },
  { id: 'compose', label: '视频合成', icon: Layers, badge: composedCount.value ? `${composedCount.value}/${mergeCandidateCount.value}` : '' },
])

const mainStageDefs = [
  { id: 'script', label: '剧本', desc: '内容改写与整理', icon: FileText },
  { id: 'assets', label: '资产', desc: '角色与场景', icon: FolderKanban },
  { id: 'storyboard', label: '分镜', desc: '镜头制作与合成', icon: Clapperboard },
  { id: 'export', label: '导出', desc: '拼接与成片输出', icon: Download },
]

const sidebarSections = computed(() => ([
  {
    id: 'script',
    label: '剧本',
    items: [
      { key: 'script:raw', label: '原始内容', desc: '', icon: FileText, done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', desc: '', icon: FileText, done: !!scriptContent.value },
      { key: 'script:extract', label: '提取', desc: '', icon: Users, done: hasExtractedAssets.value },
      ...(dubbingEnabled.value ? [{ key: 'script:voice', label: '音色', desc: '', icon: Mic2, done: !!chars.value.length && charsVoiced.value === chars.value.length }] : []),
      { key: 'script:storyboard', label: '分镜', desc: '', icon: Clapperboard, done: !!sbs.value.length },
    ],
  },
  {
    id: 'production',
    label: '制作',
    items: [
      { key: 'prod:chars', label: '角色设定稿', desc: '', icon: Users, done: prodStepDone('chars') },
      { key: 'prod:scenes', label: '场景图片', desc: '', icon: MapPin, done: prodStepDone('scenes') },
      ...(dubbingEnabled.value ? [{ key: 'prod:dubbing', label: '配音生成', desc: '', icon: Mic2, done: prodStepDone('dubbing') }] : []),
      { key: 'prod:shots', label: '镜头图片', desc: '', icon: ImageIcon, done: prodStepDone('shots') },
      { key: 'prod:videos', label: '视频生成', desc: '', icon: Video, done: prodStepDone('videos') },
      { key: 'prod:compose', label: '视频合成', desc: '', icon: Layers, done: prodStepDone('compose') },
    ],
  },
  {
    id: 'export',
    label: '导出',
    items: [
      { key: 'export:merge', label: '拼接导出', desc: '', icon: Download, done: !!mergeUrl.value },
    ],
  },
]))

const activeMainStage = computed(() => {
  if (panel.value === 'export') return 'export'
  if (panel.value === 'production') {
    return ['chars', 'scenes'].includes(prodTab.value) ? 'assets' : 'storyboard'
  }
  if (scriptStep.value <= 1) return 'script'
  if (scriptStep.value <= 3) return 'assets'
  return 'storyboard'
})

function mainStageDone(stageId) {
  if (stageId === 'script') return !!scriptContent.value
  if (stageId === 'assets') {
    const charsReady = !dubbingEnabled.value || (!!chars.value.length && charsVoiced.value === chars.value.length)
    const charImagesReady = !visualCharTotal.value || charImgCount.value === visualCharTotal.value
    const sceneImagesReady = !scenes.value.length || sceneImgCount.value === scenes.value.length
    return charsReady && charImagesReady && sceneImagesReady
  }
  if (stageId === 'storyboard') {
    if (!sbs.value.length) return false
    return isDubbingReady.value
      && shotImgCount.value === sbs.value.length
      && shotVidCount.value === sbs.value.length
      && composedCount.value === mergeCandidateCount.value
  }
  if (stageId === 'export') return !!mergeUrl.value
  return false
}

function goMainStage(stageId) {
  if (stageId === 'script') {
    panel.value = 'script'
    scriptStep.value = Math.min(scriptStep.value, 1)
    return
  }
  if (stageId === 'assets') {
    const hasAssetWorkspace = !!visualCharTotal.value || !!scenes.value.length
    const hasPendingAssetGeneration = (visualCharTotal.value && charImgCount.value < visualCharTotal.value)
      || (scenes.value.length && sceneImgCount.value < scenes.value.length)
    if (panel.value === 'production' || hasPendingAssetGeneration || hasAssetWorkspace) {
      panel.value = 'production'
      prodTab.value = ['chars', 'scenes'].includes(prodTab.value) ? prodTab.value : 'chars'
      return
    }
    panel.value = 'script'
    scriptStep.value = hasExtractedAssets.value ? (dubbingEnabled.value ? 3 : 4) : 2
    return
  }
  if (stageId === 'storyboard') {
    if (panel.value === 'production') {
      prodTab.value = ['dubbing', 'shots', 'videos', 'compose'].includes(prodTab.value)
        && (dubbingEnabled.value || prodTab.value !== 'dubbing')
        ? prodTab.value
        : 'shots'
      return
    }
    panel.value = 'script'
    scriptStep.value = 4
    return
  }
  panel.value = 'export'
}

const activeSubSteps = computed(() => {
  if (activeMainStage.value === 'script') {
    return [
      { key: 'script:raw', label: '原始内容', done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', done: !!scriptContent.value },
    ]
  }
  if (activeMainStage.value === 'assets') {
    return [
      { key: 'script:extract', label: '提取角色场景', done: hasExtractedAssets.value },
      ...(dubbingEnabled.value ? [{ key: 'script:voice', label: '分配音色', done: !!chars.value.length && charsVoiced.value === chars.value.length }] : []),
      { key: 'prod:chars', label: '角色设定稿', done: !visualCharTotal.value || charImgCount.value === visualCharTotal.value },
      { key: 'prod:scenes', label: '场景图片', done: !scenes.value.length || sceneImgCount.value === scenes.value.length },
    ]
  }
  if (activeMainStage.value === 'storyboard') {
    return [
      { key: 'script:storyboard', label: '分镜拆解', done: !!sbs.value.length },
      ...(dubbingEnabled.value ? [{ key: 'prod:dubbing', label: '配音生成', done: isDubbingReady.value }] : []),
      { key: 'prod:shots', label: '镜头图片', done: !!sbs.value.length && shotImgCount.value === sbs.value.length },
      { key: 'prod:videos', label: '视频生成', done: !!sbs.value.length && shotVidCount.value === sbs.value.length },
      { key: 'prod:compose', label: '视频合成', done: mergeCandidateCount.value > 0 && composedCount.value === mergeCandidateCount.value },
    ]
  }
  return [
    { key: 'export:merge', label: '拼接导出', done: !!mergeUrl.value },
  ]
})

const activeSubStepKey = computed(() => {
  if (panel.value === 'script') {
    if (scriptStep.value === 0) return 'script:raw'
    if (scriptStep.value === 1) return 'script:rewrite'
    if (scriptStep.value === 2) return 'script:extract'
    if (scriptStep.value === 3 && dubbingEnabled.value) return 'script:voice'
    return 'script:storyboard'
  }
  if (panel.value === 'production') return `prod:${prodTab.value}`
  return 'export:merge'
})

const sidebarJumpSteps = computed(() => {
  const section = sidebarSections.value.find((item) => item.items.some(step => step.key === activeSubStepKey.value))
  return section?.items || []
})

const bubbleSteps = computed(() => {
  if (panel.value === 'script') {
    return [
      { key: 'script:raw', label: '原始内容', done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', done: !!scriptContent.value },
      { key: 'script:extract', label: '提取', done: hasExtractedAssets.value },
      ...(dubbingEnabled.value ? [{ key: 'script:voice', label: '音色', done: !!chars.value.length && charsVoiced.value === chars.value.length }] : []),
      { key: 'script:storyboard', label: '分镜', done: !!sbs.value.length },
    ]
  }
  if (panel.value === 'production') {
    return prodTabDefs.value.map(step => ({
      key: `prod:${step.id}`,
      label: step.label,
      done: prodStepDone(step.id),
    }))
  }
  return []
})

const activeBubbleKey = computed(() => {
  if (panel.value === 'script') return activeSubStepKey.value
  if (panel.value === 'production') return `prod:${prodTab.value}`
  return ''
})

const showBottomBubble = computed(() => panel.value === 'script' || panel.value === 'production')

function goSubStep(key) {
  if (key.startsWith('script:')) {
    panel.value = 'script'
    const stepMap = {
      'script:raw': 0,
      'script:rewrite': 1,
      'script:extract': 2,
      'script:voice': 3,
      'script:storyboard': 4,
    }
    if (key === 'script:voice' && !dubbingEnabled.value) {
      scriptStep.value = 4
      return
    }
    scriptStep.value = stepMap[key] ?? 0
    return
  }
  if (key.startsWith('prod:')) {
    panel.value = 'production'
    prodTab.value = key.replace('prod:', '')
    return
  }
  panel.value = 'export'
}

const pipelineProgress = computed(() => {
  let p = 0
  if (rawContent.value) p++
  if (scriptContent.value) p++
  if (hasExtractedAssets.value) p++
  if (!dubbingEnabled.value || charsVoiced.value) p++
  if (sbs.value.length) p++
  if (!dubbingEnabled.value || (sbs.value.length && isDubbingReady.value)) p++
  if (sbs.value.some(s => s.composed_image || s.composedImage)) p++
  if (sbs.value.some(s => hasVid(s))) p++
  if (mergeCandidateCount.value > 0 && composedCount.value === mergeCandidateCount.value) p++
  if (mergeUrl.value) p++
  return p
})

const currentStageLabel = computed(() => {
  if (panel.value === 'script') return `剧本阶段 · ${stepLabels[scriptStep.value]}`
  if (panel.value === 'production') return `制作阶段 · ${prodTabDefs.value[prodTabIdx.value]?.label || '制作'}`
  return mergeUrl.value ? '导出阶段 · 成片已生成' : '导出阶段 · 等待拼接'
})

const currentMainStageLabel = computed(() => {
  const current = mainStageDefs.find(stage => stage.id === activeMainStage.value)
  return current?.label || '工作台'
})

const currentSubStageLabel = computed(() => {
  const current = activeSubSteps.value.find(step => step.key === activeSubStepKey.value)
  return current?.label || currentStageLabel.value
})

function updateCharVoice(charId, voiceId) {
  characterAPI.update(charId, { voice_style: voiceId, voice_provider: effectiveAudioConfig.value?.provider || undefined })
  const c = chars.value.find(ch => ch.id === charId)
  if (c) {
    c.voice_style = voiceId
    c.voiceStyle = voiceId
    c.voice_provider = effectiveAudioConfig.value?.provider || ''
    c.voiceProvider = effectiveAudioConfig.value?.provider || ''
    c.voice_sample_url = ''
    c.voiceSampleUrl = ''
  }
}
function getVoiceProfile(voiceId) {
  return voiceProfiles.value.find(v => v.id === voiceId) || null
}
const totalDuration = computed(() => sbs.value.reduce((s, sb) => s + (sb.duration || 5), 0))

const selectedSb = ref(null)
const shotTypes = [
  '大远景', '远景', '全景', '中景', '中近景', '近景', '特写', '大特写',
  '双人镜头', '三人镜头', '群像', '背影', '侧面', '正面', '俯视', '仰视',
  '过肩', '主观视角', '航拍', '运动镜头',
]
const shotAngles = ['平视', '仰视', '俯视', '侧拍', '背拍', '斜侧', '主观视角', '过肩']
const shotMovements = ['固定', '推镜', '拉镜', '摇镜', '移镜', '跟拍', '升降', '手持', '环绕']

function updateField(sb, field, value) {
  const current = sb[field] ?? sb[toCamel(field)]
  if (current === value) return
  sb[field] = value
  const camelField = toCamel(field)
  if (camelField !== field) sb[camelField] = value
  storyboardAPI.update(sb.id, { [field]: value })
}

function toCamel(field) {
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function getStoryboardCharacterIds(sb) {
  return sb?.character_ids || sb?.characterIds || []
}

function getStoryboardCharacterNames(sb) {
  const ids = getStoryboardCharacterIds(sb)
  return chars.value.filter(char => ids.includes(char.id)).map(char => char.name)
}

function isStoryboardCharacterSelected(sb, charId) {
  return getStoryboardCharacterIds(sb).includes(charId)
}

function toggleStoryboardCharacter(sb, charId) {
  const currentIds = getStoryboardCharacterIds(sb)
  const nextIds = currentIds.includes(charId)
    ? currentIds.filter(id => id !== charId)
    : [...currentIds, charId]
  updateField(sb, 'character_ids', nextIds)
}

function getSceneName(sb) {
  const sceneId = sb?.scene_id || sb?.sceneId
  if (!sceneId) return '未绑定场景'
  const scene = scenes.value.find(s => s.id === sceneId)
  return scene ? `${scene.location} · ${scene.time || '未设时间'}` : `场景 #${sceneId}`
}

async function deleteShot(sb) {
  if (!confirm('确定删除此镜头？')) return
  const idx = sbs.value.indexOf(sb)
  await storyboardAPI.del(sb.id)
  await refresh()
  if (sbs.value.length) selectedSb.value = sbs.value[Math.min(idx, sbs.value.length - 1)]
  else selectedSb.value = null
}

const scriptSteps = computed(() => {
  const hasScript = !!scriptContent.value
  const hasExtraction = hasExtractedAssets.value && hasScript
  const hasVoice = charsVoiced.value > 0 && hasExtraction
  const hasSbs = sbs.value.length > 0
  return [
    { label: '原始内容', state: rawContent.value ? 'done' : 'active', spinning: false },
    { label: 'AI 改写', state: hasScript ? 'done' : (rawContent.value ? 'active' : ''), spinning: rt.value === 'script_rewriter' },
    { label: '提取', state: hasExtraction ? 'done' : (hasScript ? 'active' : ''), spinning: rt.value === 'extractor' },
    ...(dubbingEnabled.value ? [{ label: '音色', state: hasVoice ? 'done' : (hasExtraction ? 'active' : ''), spinning: rt.value === 'voice_assigner' }] : []),
    { label: '分镜', state: hasSbs ? 'done' : (dubbingEnabled.value && !hasVoice ? '' : (hasExtraction ? 'active' : '')), spinning: rt.value === 'storyboard_breaker' },
  ]
})

watch(rawContent, v => { localRaw.value = v }, { immediate: true })
watch(scriptContent, v => { localScript.value = v }, { immediate: true })
watch(activeGridStoryboardId, async () => {
  if (!sbs.value.length) return
  await loadLatestGridImage()
})

async function refresh() {
  try {
    drama.value = await dramaAPI.get(dramaId)
    const ep = drama.value.episodes?.find(e => (e.episode_number || e.episodeNumber) === episodeNumber)
    if (ep) {
      episode.value = ep
      storyboardBreakdownMode.value = String(ep.breakdown_mode || ep.breakdownMode || 'standard') || 'standard'
      dubbingEnabled.value = ep.dubbing_enabled === true || ep.dubbing_enabled === 1 || ep.dubbingEnabled === true
      if (!dubbingEnabled.value) composeAudioMode.value = 'original'
      try { chars.value = await episodeAPI.characters(ep.id) } catch { chars.value = [] }
      try { scenes.value = await episodeAPI.scenes(ep.id) } catch { scenes.value = [] }
      sbs.value = await episodeAPI.storyboards(ep.id)
      try {
        const rows = await imageAPI.list({ drama_id: dramaId })
        imageGenerations.value = Array.isArray(rows) ? rows : []
      } catch {
        imageGenerations.value = []
      }
      await loadVolcAssets()
      await loadVideoGenerations()
      await loadVideoSequence()
      if (sbs.value.length && !selectedSb.value) selectedSb.value = sbs.value[0]

      const epHasContent = !!(episode.value?.content)
      const epHasScript = !!(episode.value?.script_content || episode.value?.scriptContent)
      const epHasSbs = sbs.value.length > 0

      if (epHasSbs) scriptStep.value = 4
      else if (dubbingEnabled.value && epHasScript && chars.value.some(c => c.voice_style || c.voiceStyle)) scriptStep.value = 3
      else if (epHasScript && hasExtractedAssets.value) scriptStep.value = 2
      else if (epHasScript || epHasContent) scriptStep.value = 1
      else scriptStep.value = 0
      await loadLatestGridImage()
    }
  } catch (e) {
    toast.error(e.message)
  }
  try {
    mergeData.value = await mergeAPI.status(epId.value)
    mergeBusy.value = String(mergeData.value?.status || '').toLowerCase() === 'processing'
  } catch {}
}

async function refreshExtractedAssets() {
  const [nextChars, nextScenes] = await Promise.all([
    episodeAPI.characters(epId.value),
    episodeAPI.scenes(epId.value),
  ])
  chars.value = Array.isArray(nextChars) ? nextChars : []
  scenes.value = Array.isArray(nextScenes) ? nextScenes : []
  return { chars: chars.value.length, scenes: scenes.value.length }
}

function extractedAssetCounts(result) {
  const text = String(result?.text || result?.data?.text || '')
  const counts = text.match(/\d+/g)?.map(Number) || []
  return counts.length >= 2 ? { chars: counts[0], scenes: counts[1] } : null
}

async function refreshExtractedAssetsUntilSettled(previousCounts, result) {
  const expected = extractedAssetCounts(result)
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await refreshExtractedAssets()
    const changed = current.chars !== previousCounts.chars || current.scenes !== previousCounts.scenes
    const latestResultVisible = expected
      && current.chars >= expected.chars
      && current.scenes >= expected.scenes
    if (changed || latestResultVisible || attempt === 11) return current
    await sleep(350)
  }
  return { chars: chars.value.length, scenes: scenes.value.length }
}

async function selectStoryboardBreakdownMode(mode) {
  const next = String(mode || 'standard')
  storyboardBreakdownMode.value = next
  if (!epId.value) return
  try {
    await episodeAPI.update(epId.value, { breakdown_mode: next })
    if (episode.value) episode.value.breakdown_mode = next
  } catch (e) {
    toast.error(`保存拆解模式失败：${e.message}`)
  }
}

async function setDubbingEnabled(enabled) {
  const next = !!enabled
  try {
    await episodeAPI.update(epId.value, { dubbing_enabled: next })
    dubbingEnabled.value = next
    if (next) {
      composeAudioMode.value = 'tts'
      toast.success('已开启配音流程')
    } else {
      composeAudioMode.value = 'original'
      if (scriptStep.value === 3) scriptStep.value = hasExtractedAssets.value ? 2 : 1
      if (prodTab.value === 'dubbing') prodTab.value = 'shots'
      toast.success('已关闭配音，后续将使用原声并跳过配音步骤')
    }
  } catch (e) {
    toast.error(e.message)
  }
}

async function loadVideoSequence() {
  if (!epId.value) return
  try {
    videoSequence.value = await videoAPI.getSequentialByEpisode(epId.value)
    await syncSequenceVideoGenerations(videoSequence.value)
    syncVideoSequencePolling()
  } catch {
    videoSequence.value = null
  }
}

function upsertVideoGeneration(generation) {
  if (!generation?.id) return
  const index = videoGenerations.value.findIndex(item => Number(item.id) === Number(generation.id))
  if (index === -1) {
    videoGenerations.value = [...videoGenerations.value, generation]
    return
  }
  videoGenerations.value = videoGenerations.value.map((item, itemIndex) => itemIndex === index ? generation : item)
}

async function syncSequenceVideoGenerations(sequence) {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : []
  const generationIds = [...new Set(steps
    .map(step => Number(step.video_generation_id || step.videoGenerationId || 0))
    .filter(id => id > 0)
    .filter(id => {
      const local = videoGenerations.value.find(item => Number(item.id) === id)
      return !['completed', 'failed', 'cancelled'].includes(String(local?.status || '').toLowerCase())
    }))]
  if (!generationIds.length) return
  const results = await Promise.allSettled(generationIds.map(id => videoAPI.get(id)))
  results.forEach((result) => {
    if (result.status === 'fulfilled') upsertVideoGeneration(result.value)
  })
}

function syncVideoSequencePolling() {
  if (videoSequenceTimer) {
    clearInterval(videoSequenceTimer)
    videoSequenceTimer = null
  }
  if (!sequenceBusy.value || !videoSequence.value?.id) return
  videoSequenceTimer = setInterval(async () => {
    try {
      const nextSequence = await videoAPI.getSequential(videoSequence.value.id)
      await syncSequenceVideoGenerations(nextSequence)
      videoSequence.value = nextSequence
      if (!sequenceBusy.value) {
        clearInterval(videoSequenceTimer)
        videoSequenceTimer = null
        await refresh()
      }
    } catch {}
  }, 5000)
}

async function startSequentialGeneration() {
  if (!usesSequentialVideo.value || sequenceBusy.value) return
  try {
    videoSequence.value = await videoAPI.startSequential({
      drama_id: dramaId,
      episode_id: epId.value,
      config_id: effectiveVideoConfigId.value || undefined,
      model: effectiveVideoModel.value || undefined,
      aspect_ratio: selectedVideoAspectRatio.value,
    })
    syncVideoSequencePolling()
    toast.success(`已启动${sequenceProviderLabel.value}串行生成，将按镜头顺序自动衔接`)
  } catch (e) {
    toast.error(e.message)
  }
}

async function retrySequentialGeneration(runId) {
  try {
    videoSequence.value = await videoAPI.retrySequential(runId)
    syncVideoSequencePolling()
    toast.success('已从失败镜头继续生成')
  } catch (e) { toast.error(e.message) }
}

async function cancelSequentialGeneration(runId) {
  try {
    videoSequence.value = await videoAPI.cancelSequential(runId)
    syncVideoSequencePolling()
    toast.info('已停止串行生成，已完成镜头不会回退')
  } catch (e) { toast.error(e.message) }
}

function sequenceStatusLabel(status) {
  return ({ queued: '排队中', running: '生成中', paused: '已暂停', failed: '失败', completed: '已完成', cancelled: '已停止' })[String(status || '').toLowerCase()] || status || '未知'
}
function sequenceStatusClass(status) {
  const value = String(status || '').toLowerCase()
  return value === 'completed' ? 'tag-success' : value === 'failed' ? 'tag-error' : value === 'cancelled' ? 'tag-warning' : 'tag-info'
}
function sequenceStatusDetail(sequence) {
  const step = sequenceCurrentStep.value
  if (!step) return sequence.status === 'completed' ? '全部镜头已按尾帧衔接完成。' : '等待任务处理。'
  const number = step.storyboard_number || step.storyboardNumber || Number(step.step_index ?? step.stepIndex ?? 0) + 1
  const phase = ({ preparing: '正在准备参考资产', submitting: '正在提交视频任务', processing: '正在等待视频结果', extracting_tail: sequenceProviderLabel.value === 'Grok Imagine ' ? '正在提取尾帧并上传公网图床' : '正在提取尾帧并上传火山资产' })[step.status] || '等待处理'
  return `镜头 ${number}：${phase}`
}
function sequenceAssetCount(step) {
  try {
    const assetIds = JSON.parse(step?.asset_ids || step?.assetIds || '[]')
    if (Array.isArray(assetIds) && assetIds.length) return assetIds.length
    const refs = JSON.parse(step?.asset_refs || step?.assetRefs || '[]')
    return Array.isArray(refs) ? refs.length : 0
  } catch { return 0 }
}
function sequenceAssetLabel(item) {
  const labels = { first_frame: '首帧', character: '角色', scene: '场景', prop: '道具', reference_image: '参考图' }
  return `${labels[item?.role] || '资产'} · ${item?.name || item?.asset_id || item?.assetId || ''}`
}

async function loadVolcAssets() {
  try {
    assets.value = await assetAPI.list({ drama_id: dramaId, provider: 'volcengine_asset' })
  } catch {
    assets.value = []
  }
}

async function loadVideoGenerations() {
  try {
    videoGenerations.value = await videoAPI.list({ drama_id: dramaId })
  } catch {
    videoGenerations.value = []
  }
}

async function saveRaw() {
  await episodeAPI.update(epId.value, { content: localRaw.value })
  episode.value.content = localRaw.value
  rawExtractionRequested.value = true
}
function extractionSourceForCurrentContent() {
  return rawExtractionRequested.value || localRaw.value.trim() !== rawContent.value.trim() ? 'raw' : 'script'
}
async function saveScr() {
  await episodeAPI.update(epId.value, { script_content: localScript.value })
  episode.value.script_content = localScript.value
}
async function doRewrite() {
  try {
    await saveRaw()
    rawExtractionRequested.value = false
    const rewritten = await runAgent(
      'script_rewriter',
      '请读取剧本并改写为格式化剧本，然后保存',
      dramaId,
      epId.value,
      undefined,
      { breakdown_mode: storyboardBreakdownMode.value },
    )
    if (!rewritten) return

    await refresh()
    scriptStep.value = 2
    const previousCounts = { chars: chars.value.length, scenes: scenes.value.length }
    const extracted = await runAgent(
      'extractor',
      '请从刚刚改写并保存的剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并',
      dramaId,
      epId.value,
      undefined,
      { extraction_source: 'script', breakdown_mode: storyboardBreakdownMode.value },
    )
    if (extracted) await refreshExtractedAssetsUntilSettled(previousCounts, extracted)
    await refresh()
    scriptStep.value = 2
    if (extracted) toast.success(`已自动提取 ${chars.value.length} 个角色、${scenes.value.length} 个场景`)
  } catch (e) {
    toast.error(e.message)
  }
}
async function skipRewrite() {
  const raw = (localRaw.value || rawContent.value || '').trim()
  if (!raw) {
    toast.warning('请先填写原始内容')
    return
  }
  localScript.value = raw
  await saveScr()
  rawExtractionRequested.value = false
  toast.success('已跳过 AI 改写，当前将直接使用原始内容')
  scriptStep.value = 2
}
async function doExtract() {
  try {
    const previousCounts = { chars: chars.value.length, scenes: scenes.value.length }
    const extractionSource = extractionSourceForCurrentContent()
    if (extractionSource === 'raw') await saveRaw()
    else await saveScr()
    const extracted = await runAgent(
      'extractor',
      '请从剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并',
      dramaId,
      epId.value,
      undefined,
      { extraction_source: extractionSource, breakdown_mode: storyboardBreakdownMode.value },
    )
    if (!extracted) return
    await refreshExtractedAssetsUntilSettled(previousCounts, extracted)
    await refresh()
    scriptStep.value = 2
    toast.success(`已提取 ${chars.value.length} 个角色、${scenes.value.length} 个场景`)
  } catch (e) {
    toast.error(e.message)
  }
}
function doVoice() { runAgent('voice_assigner', '请为所有角色分配合适的音色', dramaId, epId.value, refresh) }
async function batchGenSamples() {
  const pending = chars.value.filter(c => (c.voice_style || c.voiceStyle) && !(c.voice_sample_url || c.voiceSampleUrl))
  if (!pending.length) {
    toast.info(charsVoiced.value ? '所有角色的试听文件已生成' : '请先分配音色')
    return
  }
  const results = await Promise.allSettled(pending.map(c => characterAPI.voiceSample(c.id, epId.value, audioGenerationOptions.value)))
  const okCount = results.filter(r => r.status === 'fulfilled').length
  const failCount = results.length - okCount
  if (okCount) toast.success(`已生成 ${okCount} 份试听文件`)
  if (failCount) toast.error(`${failCount} 份试听文件生成失败`)
  await refresh()
}
function doBreakdown() {
  const cfg = effectiveVideoConfig.value
  const model = effectiveVideoModel.value || firstConfigModel(cfg)
  const label = selectedConfigModelLabel(cfg, model)
  const policy = storyboardBreakdownPolicy.value
  const sceneCount = scenes.value.length
  const sceneScope = sceneCount
    ? `本集当前已提取 ${sceneCount} 个场景`
    : '本集场景数量尚未在前端统计，必须以 read_storyboard_context 返回的实际场景列表为准'
  const policyText = storyboardBreakdownMode.value === 'tk_overseas'
    ? `当前选择 TK海外剧拆解：${sceneScope}；场景数量仅以当前集实际提取结果和 read_storyboard_context 返回内容为准，绝对不得假设固定为三个场景，也不得自行新增或删减场景。英文对白保留原文，不读取括号中文翻译；逐个覆盖当前集所有场景，保留原剧本动作、对白和结果。总时长目标60-90秒，允许因剧情完整度浮动到100秒；不设固定镜头数量，按实际叙事节拍拆分，每镜通常4-10秒，连续动作或较长对白确有需要时可使用11-15秒。`
    : policy
      ? '当前选择 Grok 10s · 3分钟内拆解：请压缩主线，最多18个镜头，每个镜头10秒，总时长不超过180秒。'
      : storyboardBreakdownMode.value === 'full'
        ? '当前选择完整拆解：保留剧本细节，但不得新增剧本外剧情。'
        : '当前选择普通紧凑拆解：简单动作、反应和环境建立镜头使用4-5秒，关键对白或连续动作使用5-7秒；只在叙事重点明显变化时切镜，不要凑镜头数量。'
  runAgent(
    'storyboard_breaker',
    `请拆解分镜并生成视频提示词。注意：分镜拆解本身使用后端文本 Agent 配置，不调用视频模型；以下视频模型只作为后续视频提示词格式参考：${label}。${policyText} 请根据该模型的特性和时长限制生成合适的视频提示词。`,
    dramaId,
    epId.value,
    refresh,
    {
      video_model: model || '',
      video_provider: cfg?.provider || '',
      video_model_label: label,
      storyboard_mode: storyboardBreakdownMode.value,
      storyboard_policy: policy || undefined,
    },
  )
}
async function genSample(id) { try { await characterAPI.voiceSample(id, epId.value, audioGenerationOptions.value); toast.success('试听已生成'); refresh() } catch (e) { toast.error(e.message) } }
async function addShot() { await storyboardAPI.create({ episode_id: epId.value, storyboard_number: sbs.value.length + 1, title: `镜头${sbs.value.length + 1}`, duration: 5 }); refresh() }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function watchAsyncResult(check, attempts = 24, delay = 2500) {
  void (async () => {
    for (let i = 0; i < attempts; i++) {
      await sleep(delay)
      await refresh()
      if (check()) return
    }
  })()
}

async function pollAssetImageGeneration({
  generationId,
  entityId,
  previousPath,
  getEntity,
  clearPending,
  failureMessage = '图片生成失败',
  timeoutMessage = '图片生成超时',
}) {
  for (let i = 0; i < 120; i++) {
    await sleep(4000)
    try {
      const generation = generationId ? await imageAPI.get(generationId) : null
      await refresh()
      const entity = getEntity(entityId)
      const currentPath = imagePath(entity?.image_url || entity?.imageUrl)
      const result = shouldFinishImageRegenerationPoll({ generation, currentPath, previousPath })
      if (result.done) {
        clearPending(entityId)
        if (result.failed) toast.error(result.error || failureMessage)
        return
      }
    } catch {}
  }
  clearPending(entityId)
  toast.error(timeoutMessage)
}

async function genCharImg(id) {
  try {
    if (!isPendingCharImage(id)) pendingCharImageIds.value.push(id)
    const currentChar = chars.value.find(c => c.id === id)
    const previousPath = imagePath(currentChar?.image_url || currentChar?.imageUrl)
    const result = await characterAPI.generateImage(id, epId.value, imageGenerationOptions.value)
    const generationId = result?.image_generation_id || result?.imageGenerationId
    toast.success('角色设定稿生成中')
    await refresh()
    pollAssetImageGeneration({
      generationId,
      entityId: id,
      previousPath,
      getEntity: entityId => chars.value.find(c => c.id === entityId),
      clearPending: entityId => { pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== entityId) },
      failureMessage: '角色设定稿生成失败',
      timeoutMessage: '角色设定稿生成超时',
    })
  } catch (e) {
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
    toast.error(e.message)
  }
}
async function batchCharImages() {
  const ids = visualChars.value.filter(c => !(c.image_url || c.imageUrl)).map(c => c.id)
  if (!ids.length) { toast.info('所有角色设定稿已生成'); return }
  pendingCharImageIds.value = [...new Set([...pendingCharImageIds.value, ...ids])]
  try {
    const result = await characterAPI.batchImages(ids, epId.value, imageGenerationOptions.value)
    toast.success('角色设定稿批量生成中')
    await refresh()
    const generationIds = Array.isArray(result?.ids) ? result.ids : []
    generationIds.forEach((generationId, index) => {
      const entityId = ids[index]
      if (!generationId || !entityId) return
      pollAssetImageGeneration({
        generationId,
        entityId,
        previousPath: '',
        getEntity: targetId => chars.value.find(c => c.id === targetId),
        clearPending: targetId => { pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== targetId) },
        failureMessage: '角色设定稿生成失败',
        timeoutMessage: '角色设定稿生成超时',
      })
    })
    const missingGenerationIds = ids.slice(generationIds.length)
    if (missingGenerationIds.length) {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !missingGenerationIds.includes(item))
      toast.error(`${missingGenerationIds.length} 个角色图片任务未成功提交`)
    }
  } catch (e) {
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !ids.includes(item))
    toast.error(e.message)
  }
}
async function genSceneImg(id) {
  try {
    if (!isPendingSceneImage(id)) pendingSceneImageIds.value.push(id)
    const currentScene = scenes.value.find(s => s.id === id)
    const previousPath = imagePath(currentScene?.image_url || currentScene?.imageUrl)
    const result = await sceneAPI.generateImage(id, epId.value, imageGenerationOptions.value)
    const generationId = result?.image_generation_id || result?.imageGenerationId
    toast.success('场景图片生成中')
    await refresh()
    pollAssetImageGeneration({
      generationId,
      entityId: id,
      previousPath,
      getEntity: entityId => scenes.value.find(s => s.id === entityId),
      clearPending: entityId => { pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== entityId) },
      failureMessage: '场景图片生成失败',
      timeoutMessage: '场景图片生成超时',
    })
  } catch (e) {
    pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
    toast.error(e.message)
  }
}
async function batchSceneImages() {
  const ids = scenes.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
  if (!ids.length) { toast.info('所有场景图片已生成'); return }
  pendingSceneImageIds.value = [...new Set([...pendingSceneImageIds.value, ...ids])]
  let submitted = 0
  for (const id of ids) {
    try {
      const result = await sceneAPI.generateImage(id, epId.value, imageGenerationOptions.value)
      const generationId = result?.image_generation_id || result?.imageGenerationId
      if (!generationId) throw new Error('图片任务未返回任务 ID')
      submitted += 1
      pollAssetImageGeneration({
        generationId,
        entityId: id,
        previousPath: '',
        getEntity: targetId => scenes.value.find(s => s.id === targetId),
        clearPending: targetId => { pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== targetId) },
        failureMessage: '场景图片生成失败',
        timeoutMessage: '场景图片生成超时',
      })
    } catch (e) {
      pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
      toast.error(e.message)
    }
  }
  if (submitted) toast.success(`已提交 ${submitted} 个场景图片任务，谜镜将按顺序生成`)
  await refresh()
}

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function getDialogueSpeakerRaw(sb) {
  const speakers = getDialogueLines(sb).map(line => line.speaker).filter(Boolean)
  return [...new Set(speakers)].join(' / ')
}

function getDialogueText(sb) {
  return getDialogueLines(sb).map(line => line.text).join('\n')
}

function isTTSIgnorable(sb) {
  return getDialogueLines(sb).length === 0
}

function hasDialogue(sb) { return !isTTSIgnorable(sb) }
function hasTTS(sb) { return !!(sb?.tts_audio_url || sb?.ttsAudioUrl) }
function getTTSUrl(sb) { return sb?.tts_audio_url || sb?.ttsAudioUrl || '' }
function getDialogueSpeaker(sb) {
  const speakers = getDialogueLines(sb).map(line => line.speaker || '旁白').filter(Boolean)
  const unique = [...new Set(speakers)]
  if (!unique.length) return '旁白'
  if (unique.length > 2) return `${unique[0]}等${unique.length}人`
  return unique.join(' / ')
}

function getDialogueLines(sb) {
  const raw = sb?.dialogue?.trim() || ''
  if (!raw) return []
  const matches = [...raw.matchAll(/(?:^|\n)\s*([^：:\n]{1,40})[：:]\s*/g)]
  const lines = matches.length
    ? matches.map((match, index) => {
      const next = matches[index + 1]
      const textStart = (match.index || 0) + match[0].length
      const textEnd = next?.index ?? raw.length
      return {
        speaker: cleanDialogueSpeaker(match[1]),
        text: cleanDialogueText(raw.slice(textStart, textEnd)),
      }
    })
    : [{ speaker: '', text: cleanDialogueText(raw) }]

  return lines.filter(line => {
    if (!line.text) return false
    if (line.speaker && IGNORE_TTS_SPEAKERS.test(line.speaker)) return false
    return !IGNORE_TTS_TEXT.test(line.text)
  })
}

function cleanDialogueSpeaker(value) {
  return String(value || '').replace(/[（(].*?[)）]/g, '').trim()
}

function cleanDialogueText(value) {
  return String(value || '').replace(/[（(].*?[)）]/g, '').trim()
}
async function genShotTTS(sb) {
  if (isPendingTTS(sb.id)) return
  pendingTTSIds.value = [...new Set([...pendingTTSIds.value, sb.id])]
  clearTTSFailure(sb.id)
  try {
    const result = await storyboardAPI.generateTTS(sb.id, audioGenerationOptions.value)
    const target = sbs.value.find(item => Number(item.id) === Number(sb.id))
    if (target && result?.tts_audio_url) {
      target.tts_audio_url = result.tts_audio_url
      target.ttsAudioUrl = result.tts_audio_url
    }
    toast.success(`镜头 #${sb.storyboard_number || sb.storyboardNumber || sb.id} 配音已生成`)
    await refresh()
  } catch (e) {
    setTTSFailure(sb.id, e.message)
    toast.error(e.message)
  } finally {
    pendingTTSIds.value = pendingTTSIds.value.filter(id => id !== sb.id)
  }
}
async function batchShotTTS() {
  if (batchTTSRunning.value) return
  const pending = sbs.value.filter(sb => hasDialogue(sb) && !hasTTS(sb) && !isPendingTTS(sb.id))
  if (!pending.length) {
    toast.info(ttsEligibleCount.value ? '所有镜头配音已生成' : '当前没有可生成的对白或旁白')
    return
  }
  batchTTSRunning.value = true
  ttsBatchProgress.value = { done: 0, total: pending.length }
  pendingTTSIds.value = [...new Set([...pendingTTSIds.value, ...pending.map(sb => sb.id)])]
  pending.forEach(sb => clearTTSFailure(sb.id))
  toast.info(`开始批量生成 ${pending.length} 条镜头配音`)

  let okCount = 0
  let failCount = 0
  try {
    for (const sb of pending) {
      try {
        const result = await storyboardAPI.generateTTS(sb.id, audioGenerationOptions.value)
        const target = sbs.value.find(item => Number(item.id) === Number(sb.id))
        if (target && result?.tts_audio_url) {
          target.tts_audio_url = result.tts_audio_url
          target.ttsAudioUrl = result.tts_audio_url
        }
        clearTTSFailure(sb.id)
        okCount += 1
      } catch (e) {
        failCount += 1
        setTTSFailure(sb.id, e.message)
      } finally {
        pendingTTSIds.value = pendingTTSIds.value.filter(id => id !== sb.id)
        ttsBatchProgress.value = { ...ttsBatchProgress.value, done: okCount + failCount }
      }
    }
  } finally {
    batchTTSRunning.value = false
    if (okCount) toast.success(`已生成 ${okCount} 条镜头配音`)
    if (failCount) toast.error(`${failCount} 条镜头配音生成失败，失败原因已标在对应镜头下方`)
    await refresh()
  }
}

function getFirstFrame(s) { return s?.first_frame_image || s?.firstFrameImage || null }
function getLastFrame(s) { return s?.last_frame_image || s?.lastFrameImage || null }
function hasShotFrame(s, frameType) {
  return frameType === 'first_frame' ? !!getFirstFrame(s) : !!getLastFrame(s)
}
function getStoryboardCover(s) { return s?.composed_image || s?.composedImage || getFirstFrame(s) || getLastFrame(s) || getRefs(s)[0] || null }
function getVideoUrl(s) { return s?.video_url || s?.videoUrl || null }
function getComposedVideoUrl(s) { return s?.composed_video_url || s?.composedVideoUrl || null }
function isCompletedGeneration(generation) {
  return String(generation?.status || '').toLowerCase() === 'completed'
}
function getGenerationLocalPath(generation) {
  const localPath = String(generation?.local_path || generation?.localPath || '').trim()
  if (localPath) return localPath
  const videoUrl = String(generation?.video_url || generation?.videoUrl || '').trim()
  return isLocalMedia(videoUrl) ? videoUrl.replace(/^\/+/, '') : ''
}
function getDisplayShotVideoUrl(s) {
  const latest = latestVideoGeneration(s?.id)
  if (latest) return isCompletedGeneration(latest) ? getGenerationVideoUrl(latest) : ''
  return getVideoUrl(s)
}
function getDownloadShotVideoUrl(s) {
  const localGeneration = latestLocalCompletedVideoGeneration(s?.id)
  return getGenerationLocalPath(localGeneration)
}
function getGenerationVideoUrl(generation) { return generation?.video_url || generation?.videoUrl || null }
function mediaSrc(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  return /^https?:\/\//i.test(url) ? url : `/${url.replace(/^\/+/, '')}`
}
function isLocalMedia(value) {
  return /^\/?static\//.test(String(value || '').trim())
}
function hasImg(s) { return !!getStoryboardCover(s) }
function hasVideoReferenceInput(s) { return hasImg(s) || getRefs(s).length > 0 }
function hasVid(s) {
  const latest = latestVideoGeneration(s?.id)
  return latest ? isCompletedGeneration(latest) && !!getGenerationVideoUrl(latest) : !!getVideoUrl(s)
}
function hasComposed(s) { return !!getComposedVideoUrl(s) }

function latestVideoGeneration(storyboardId) {
  return videoGenerations.value
    .filter(item => (item.storyboard_id || item.storyboardId) === storyboardId)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null
}

function latestVideoPrompt(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  const finalPrompt = latest?.final_prompt || latest?.finalPrompt || ''
  if (finalPrompt && !isLegacyVolcInlineAssetPrompt(finalPrompt)) return finalPrompt
  return latest?.prompt || ''
}

function latestVideoPromptIsFinal(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  const finalPrompt = latest?.final_prompt || latest?.finalPrompt || ''
  return (latest?.prompt_is_final === true || latest?.promptIsFinal === true || !!finalPrompt)
    && !isLegacyVolcInlineAssetPrompt(finalPrompt)
}

function isLegacyVolcInlineAssetPrompt(prompt) {
  const value = String(prompt || '')
  if (!value) return false
  return /<(role|location)>[\s\S]*?@asset:\/\//i.test(value)
    || /(?:镜头|角色|场景)参考资产ID：/.test(value)
    || /参考图\d+\s+@asset:\/\//.test(value)
    || /(?:脸型|发型|服装|着装|外形|人物形象)/.test(value)
}

function isPreparedVideoPrompt(prompt) {
  const value = String(prompt || '')
  return value.includes('@asset://')
    || value.includes('Seedance 2.0 参考素材约束')
    || value.includes('Eggfans/Grok 视频参考图')
    || value.includes('Grok公网参考')
}

function hasAutoInjectedDialogueBlock(prompt) {
  return String(prompt || '').includes('视频对白约束（自动注入 BEGIN）')
}

function baseStoryboardVideoPrompt(sb) {
  return sb?.video_prompt || sb?.videoPrompt || ''
}

function videoPromptDraft(sb) {
  const key = String(sb.id)
  return videoPromptDraftVersions.value[key] === storyboardPromptVersion(sb) && videoPromptDrafts.value[key] != null
    ? videoPromptDrafts.value[key]
    : latestVideoPrompt(sb.id) ?? baseStoryboardVideoPrompt(sb)
}

function setVideoPromptDraft(storyboardId, value) {
  videoPromptDrafts.value = { ...videoPromptDrafts.value, [String(storyboardId)]: value }
  const sb = sbs.value.find(item => Number(item.id) === Number(storyboardId))
  if (sb) videoPromptDraftVersions.value = { ...videoPromptDraftVersions.value, [String(storyboardId)]: storyboardPromptVersion(sb) }
}

function storyboardPromptVersion(sb) {
  return [
    sb?.updated_at || sb?.updatedAt || '',
    baseStoryboardVideoPrompt(sb),
    sb?.dialogue || '',
    sb?.action || '',
    sb?.description || '',
  ].join('\n')
}

function hasCurrentVideoPromptDraft(sb) {
  return videoPromptDraftVersions.value[String(sb.id)] === storyboardPromptVersion(sb)
    && String(videoPromptDrafts.value[String(sb.id)] || '').trim().length > 0
}

function isVideoPromptEditorOpen(storyboardId) {
  return openVideoPromptIds.value.includes(storyboardId)
}

async function toggleVideoPromptEditor(sb) {
  if (isVideoPromptEditorOpen(sb.id)) {
    openVideoPromptIds.value = openVideoPromptIds.value.filter(id => id !== sb.id)
    return
  }
  if (!hasCurrentVideoPromptDraft(sb)) {
    setVideoPromptDraft(sb.id, latestVideoPrompt(sb.id) || baseStoryboardVideoPrompt(sb))
  }
  openVideoPromptIds.value = [...new Set([...openVideoPromptIds.value, sb.id])]
  if (
    !isPreparedVideoPrompt(videoPromptDrafts.value[String(sb.id)] || '')
    || (String(sb.dialogue || '').trim() && !hasAutoInjectedDialogueBlock(videoPromptDrafts.value[String(sb.id)] || ''))
  ) {
    await refreshVideoPromptDraft(sb, true)
  }
}

function resetVideoPromptDraft(sb) {
  setVideoPromptDraft(sb.id, baseStoryboardVideoPrompt(sb))
}

async function refreshVideoPromptDraft(sb, silent = false) {
  if (isPreviewingVideoPrompt(sb.id)) return
  const basePrompt = baseStoryboardVideoPrompt(sb)
  if (!basePrompt.trim()) {
    if (!silent) toast.warning('当前镜头没有视频提示词')
    return
  }
  previewingVideoPromptIds.value = [...new Set([...previewingVideoPromptIds.value, sb.id])]
  try {
    const res = await videoAPI.previewPrompt(buildVideoRequestParams(sb, basePrompt, false))
    const prompt = res?.final_prompt || res?.finalPrompt || res?.prompt || ''
    setVideoPromptDraft(sb.id, prompt)
    if (!isVideoPromptEditorOpen(sb.id)) {
      openVideoPromptIds.value = [...new Set([...openVideoPromptIds.value, sb.id])]
    }
    if (!silent) toast.success(buildVideoPromptRefreshMessage(res))
  } catch (e) {
    toast.error(e.message)
  } finally {
    previewingVideoPromptIds.value = previewingVideoPromptIds.value.filter(id => id !== sb.id)
  }
}

function buildVideoPromptRefreshMessage(res) {
  const count = res?.asset_count ?? res?.assetCount ?? 0
  const kind = res?.reference_kind || res?.referenceKind || ''
  const provider = String(res?.provider || '').toLowerCase()
  if (kind === 'public_image_url' || provider === 'eggfans') {
    return `传输稿已刷新，包含 ${count} 个公网参考图`
  }
  if (kind === 'volc_asset' || provider === 'volcengine') {
    return `传输稿已刷新，包含 ${count} 个火山资产`
  }
  return `传输稿已刷新，包含 ${count} 个参考素材`
}

function latestCompletedVideoGeneration(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  return latest && isCompletedGeneration(latest) ? latest : null
}

function latestLocalCompletedVideoGeneration(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  return latest && isCompletedGeneration(latest) && getGenerationLocalPath(latest) ? latest : null
}

function exportableVideoGeneration(storyboardId) {
  return latestLocalCompletedVideoGeneration(storyboardId) || latestCompletedVideoGeneration(storyboardId)
}

function latestFailedVideoMessage(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  if (!latest || latest.status !== 'failed') return ''
  return latest.error_msg || latest.errorMsg || '视频生成失败'
}

function isBackendVideoProcessing(storyboardId) {
  const latest = latestVideoGeneration(storyboardId)
  return ['pending', 'processing', 'running', 'queued'].includes(String(latest?.status || '').toLowerCase())
}

function isVideoBusy(storyboardId) {
  return isPendingVideo(storyboardId) || isBackendVideoProcessing(storyboardId)
}

function isPreviewingVideoPrompt(storyboardId) {
  return previewingVideoPromptIds.value.includes(storyboardId)
}

function getVideoReferenceUrls(sb) {
  const refs = []
  const pushRef = (value) => {
    const path = String(value || '').trim()
    if (!path || refs.includes(path)) return
    refs.push(path)
  }
  const first = getFirstFrame(sb)
  const last = getLastFrame(sb)
  const manualRefs = getRefs(sb)
  if (manualRefs.length) {
    manualRefs.forEach(pushRef)
  } else {
    pushRef(first)
    pushRef(last)
  }
  return refs
}

function isGrokVideoModelName(model) {
  const normalized = String(model || '').toLowerCase()
  return normalized.includes('grok-video') || normalized.includes('grok-imagine-video')
}

function getGrokVideoReferenceItems(sb) {
  const items = []
  const seen = new Set()
  const push = (url, label) => {
    const value = String(url || '').trim()
    if (!value || seen.has(value) || items.length >= 7) return
    seen.add(value)
    items.push({
      key: `${sb.id}:grok:${items.length}:${value}`,
      url: value,
      label,
    })
  }

  getRefs(sb).forEach((url, index) => push(url, `镜头参考图${index + 1}`))

  const sceneId = sb?.scene_id || sb?.sceneId
  const scene = scenes.value.find(item => item.id === sceneId)
  if (scene) push(scene.image_url || scene.imageUrl, `场景-${scene.location || scene.name || scene.id}`)

  for (const charId of getStoryboardCharacterIds(sb)) {
    const char = chars.value.find(item => item.id === charId)
    if (!char) continue
    push(char.image_url || char.imageUrl, `角色-${char.name || char.id}`)
  }

  return items
}

function buildVideoRequestParams(sb, prompt, promptIsFinal = false) {
  const params = {
    storyboard_id: sb.id,
    drama_id: dramaId,
    config_id: effectiveVideoConfigId.value || undefined,
    model: effectiveVideoModel.value || undefined,
    prompt,
    prompt_is_final: promptIsFinal,
    duration: Number(sb.duration || 5),
    aspect_ratio: selectedVideoAspectRatio.value,
  }
  const first = getFirstFrame(sb)
  const last = getLastFrame(sb)
  const refs = getRefs(sb)
  if (usesGrokPublicVideoReferences.value) {
    Object.assign(params, {
      reference_mode: 'multiple',
      ...(refs.length ? { reference_image_urls: refs.slice(0, 7) } : {}),
    })
  }
  else if (refs.length) { Object.assign(params, { reference_mode: 'multiple', reference_image_urls: refs }) }
  else if (first && last) { Object.assign(params, { reference_mode: 'first_last', first_frame_url: first, last_frame_url: last }) }
  else if (first) { Object.assign(params, { reference_mode: 'single', image_url: first }) }
  return params
}

function getVolcReferenceItems(sb) {
  const urls = getVideoReferenceUrls(sb)
  return urls.map((url, index) => {
    const key = volcReferenceKey(sb.id, url)
    const asset = findVolcAssetBySource(url)
    return {
      key,
      url,
      index,
      name: `镜头${sb.storyboard_number || sb.storyboardNumber || index + 1}-参考图${index + 1}`,
      asset,
      assetId: asset?.provider_asset_id || asset?.providerAssetId || '',
      status: asset ? 'uploaded' : (manualVolcAssetFailures.value[key] ? 'failed' : 'missing'),
      error: manualVolcAssetFailures.value[key] || '',
    }
  })
}

const allVolcReferenceItems = computed(() => sbs.value.flatMap(sb => getVolcReferenceItems(sb).map(item => ({ ...item, storyboard: sb }))))
const allCharacterVolcAssetItems = computed(() => visualChars.value.map(getCharacterVolcAssetItem).filter(Boolean))
const allSceneVolcAssetItems = computed(() => scenes.value.map(getSceneVolcAssetItem).filter(Boolean))

function volcReferenceKey(storyboardId, url) {
  return `${storyboardId}:${url}`
}

function semanticVolcAssetKey(category, entityId, url) {
  return `${category}:${entityId}:${url}`
}

function findVolcAssetBySource(url) {
  const source = String(url || '').trim()
  if (!source) return null
  return assets.value.find(asset => {
    const assetSource = asset.source_url || asset.sourceUrl
    return assetSource === source && (asset.provider_asset_id || asset.providerAssetId)
  }) || null
}

function getCharacterVolcAssetItem(char) {
  const url = String(char?.image_url || char?.imageUrl || '').trim()
  if (!url) return null
  const key = semanticVolcAssetKey('character', char.id, url)
  const asset = findVolcAssetBySource(url)
  return {
    key,
    url,
    index: 0,
    entityId: char.id,
    entityName: char.name || '角色',
    name: `角色-${char.name || char.id}`,
    category: 'character',
    asset,
    assetId: asset?.provider_asset_id || asset?.providerAssetId || '',
    status: asset ? 'uploaded' : (manualVolcAssetFailures.value[key] ? 'failed' : 'missing'),
    error: manualVolcAssetFailures.value[key] || '',
  }
}

function getSceneVolcAssetItem(scene) {
  const url = String(scene?.image_url || scene?.imageUrl || '').trim()
  if (!url) return null
  const key = semanticVolcAssetKey('scene', scene.id, url)
  const asset = findVolcAssetBySource(url)
  return {
    key,
    url,
    index: 0,
    entityId: scene.id,
    entityName: scene.location || '场景',
    name: `场景-${scene.location || scene.id}`,
    category: 'scene',
    asset,
    assetId: asset?.provider_asset_id || asset?.providerAssetId || '',
    status: asset ? 'uploaded' : (manualVolcAssetFailures.value[key] ? 'failed' : 'missing'),
    error: manualVolcAssetFailures.value[key] || '',
  }
}

function volcReferenceStatusLabel(item) {
  if (isPendingVolcAsset(item.key)) return '上传中'
  if (item.asset) return '已上传'
  if (item.error) return '失败'
  return '未上传'
}

function volcReferenceStatusClass(item) {
  if (isPendingVolcAsset(item.key)) return 'tag-info'
  if (item.asset) return 'tag-success'
  if (item.error) return 'tag-error'
  return 'tag-warning'
}

function volcReferencePayload(sb, item) {
  return {
    url: item.url,
    name: item.name,
    category: 'storyboard',
    drama_id: dramaId,
    episode_id: epId.value,
    storyboard_id: sb.id,
    storyboard_num: sb.storyboard_number || sb.storyboardNumber || null,
    group_name: drama.value?.title ? `${drama.value.title}-火山素材库` : `Eggfans-短剧-${dramaId}`,
    source: 'volc:manualReferenceSync',
  }
}

function semanticVolcReferencePayload(item) {
  return {
    url: item.url,
    name: item.name,
    category: item.category,
    drama_id: dramaId,
    episode_id: epId.value,
    group_name: drama.value?.title ? `${drama.value.title}-火山素材库` : `Eggfans-短剧-${dramaId}`,
    source: item.category === 'character' ? 'volc:characterReferenceSync' : 'volc:sceneReferenceSync',
  }
}

async function syncVolcReference(sb, item, force = false) {
  const key = item.key
  if (isPendingVolcAsset(key)) return
  delete manualVolcAssetFailures.value[key]
  pendingVolcAssetKeys.value = [...new Set([...pendingVolcAssetKeys.value, key])]
  try {
    const res = await assetAPI.syncVolc([volcReferencePayload(sb, item)], {
      force,
      drama_id: dramaId,
      episode_id: epId.value,
      group_name: drama.value?.title ? `${drama.value.title}-火山素材库` : `Eggfans-短剧-${dramaId}`,
    })
    const result = res?.items?.[0]
    if (!result?.success) {
      const message = result?.error || '上传火山素材失败'
      manualVolcAssetFailures.value = { ...manualVolcAssetFailures.value, [key]: message }
      toast.error(message)
    } else {
      toast.success(force ? '参考图已重新上传火山素材' : '参考图已上传火山素材')
    }
    await loadVolcAssets()
  } catch (e) {
    manualVolcAssetFailures.value = { ...manualVolcAssetFailures.value, [key]: e.message }
    toast.error(e.message)
  } finally {
    pendingVolcAssetKeys.value = pendingVolcAssetKeys.value.filter(itemKey => itemKey !== key)
  }
}

async function syncCharacterVolcAsset(char, force = false) {
  const item = getCharacterVolcAssetItem(char)
  if (!item) {
    toast.warning('请先生成角色设定稿')
    return
  }
  await syncSemanticVolcAssets([item], force, '角色素材')
}

async function syncSceneVolcAsset(scene, force = false) {
  const item = getSceneVolcAssetItem(scene)
  if (!item) {
    toast.warning('请先生成场景图片')
    return
  }
  await syncSemanticVolcAssets([item], force, '场景素材')
}

async function syncAllCharacterVolcAssets(force = false) {
  const refs = allCharacterVolcAssetItems.value.filter(ref => force || !ref.asset)
  if (!refs.length) {
    toast.success('所有角色素材都已上传火山')
    return
  }
  await syncSemanticVolcAssets(refs, force, '角色素材')
}

async function syncAllSceneVolcAssets(force = false) {
  const refs = allSceneVolcAssetItems.value.filter(ref => force || !ref.asset)
  if (!refs.length) {
    toast.success('所有场景素材都已上传火山')
    return
  }
  await syncSemanticVolcAssets(refs, force, '场景素材')
}

async function syncSemanticVolcAssets(refs, force = false, label = '素材') {
  const unique = []
  const seen = new Set()
  refs.forEach((item) => {
    if (!item?.url || seen.has(item.key)) return
    seen.add(item.key)
    unique.push(item)
  })
  if (!unique.length) return

  unique.forEach((item) => {
    delete manualVolcAssetFailures.value[item.key]
  })
  pendingVolcAssetKeys.value = [...new Set([...pendingVolcAssetKeys.value, ...unique.map(item => item.key)])]

  try {
    const res = await assetAPI.syncVolc(unique.map(semanticVolcReferencePayload), {
      force,
      drama_id: dramaId,
      episode_id: epId.value,
      group_name: drama.value?.title ? `${drama.value.title}-火山素材库` : `Eggfans-短剧-${dramaId}`,
    })
    const nextFailures = { ...manualVolcAssetFailures.value }
    ;(res?.items || []).forEach((result, index) => {
      const key = unique[index]?.key
      if (!key) return
      if (result?.success) delete nextFailures[key]
      else nextFailures[key] = result?.error || `上传火山${label}失败`
    })
    manualVolcAssetFailures.value = nextFailures
    await loadVolcAssets()
    if (res?.failed_count) toast.error(`${res.failed_count}/${res.total} 个${label}上传失败`)
    if (res?.ok_count) toast.success(force ? `${res.ok_count}/${res.total} 个${label}已重新上传火山` : `${res.ok_count}/${res.total} 个${label}已上传火山`)
  } catch (e) {
    const nextFailures = { ...manualVolcAssetFailures.value }
    unique.forEach((item) => { nextFailures[item.key] = e.message })
    manualVolcAssetFailures.value = nextFailures
    toast.error(e.message)
  } finally {
    const done = new Set(unique.map(item => item.key))
    pendingVolcAssetKeys.value = pendingVolcAssetKeys.value.filter(key => !done.has(key))
  }
}

async function syncStoryboardVolcReferences(sb, force = false) {
  const refs = getVolcReferenceItems(sb)
  if (!refs.length) {
    toast.warning('当前镜头没有参考图')
    return
  }
  await syncVolcReferences(refs.map(item => ({ sb, item })), force)
}

async function syncAllVolcReferences(force = false) {
  const refs = allVolcReferenceItems.value
    .filter(ref => force || !ref.asset)
    .map(ref => ({ sb: ref.storyboard, item: ref }))
  if (!refs.length) {
    toast.success('所有参考图都已上传火山素材')
    return
  }
  await syncVolcReferences(refs, force)
}

async function syncVolcReferences(refs, force = false) {
  const unique = []
  const seen = new Set()
  refs.forEach(({ sb, item }) => {
    if (!item?.url || seen.has(item.key)) return
    seen.add(item.key)
    unique.push({ sb, item })
  })
  if (!unique.length) return

  unique.forEach(({ item }) => {
    delete manualVolcAssetFailures.value[item.key]
  })
  pendingVolcAssetKeys.value = [...new Set([...pendingVolcAssetKeys.value, ...unique.map(({ item }) => item.key)])]

  try {
    const res = await assetAPI.syncVolc(unique.map(({ sb, item }) => volcReferencePayload(sb, item)), {
      force,
      drama_id: dramaId,
      episode_id: epId.value,
      group_name: drama.value?.title ? `${drama.value.title}-火山素材库` : `Eggfans-短剧-${dramaId}`,
    })
    const nextFailures = { ...manualVolcAssetFailures.value }
    ;(res?.items || []).forEach((result, index) => {
      const key = unique[index]?.item?.key
      if (!key) return
      if (result?.success) delete nextFailures[key]
      else nextFailures[key] = result?.error || '上传火山素材失败'
    })
    manualVolcAssetFailures.value = nextFailures
    await loadVolcAssets()
    if (res?.failed_count) toast.error(`${res.failed_count}/${res.total} 张参考图上传失败`)
    if (res?.ok_count) toast.success(`${res.ok_count}/${res.total} 张参考图已上传火山素材`)
  } catch (e) {
    const nextFailures = { ...manualVolcAssetFailures.value }
    unique.forEach(({ item }) => { nextFailures[item.key] = e.message })
    manualVolcAssetFailures.value = nextFailures
    toast.error(e.message)
  } finally {
    const done = new Set(unique.map(({ item }) => item.key))
    pendingVolcAssetKeys.value = pendingVolcAssetKeys.value.filter(key => !done.has(key))
  }
}

function getShotReferenceImages(sb) {
  const refs = []
  const pushRef = (value) => {
    if (!value || refs.includes(value) || refs.length >= 6) return
    refs.push(value)
  }
  const sceneId = sb?.scene_id || sb?.sceneId
  const scene = scenes.value.find(item => item.id === sceneId)
  pushRef(scene?.image_url || scene?.imageUrl)
  for (const charId of getStoryboardCharacterIds(sb)) {
    const char = chars.value.find(item => item.id === charId)
    pushRef(char?.image_url || char?.imageUrl)
  }
  for (const referenceImage of getRefs(sb)) {
    pushRef(referenceImage)
  }
  return refs.filter(Boolean).slice(0, 6)
}

function buildShotImagePrompt(sb, frameType) {
  const title = sb.title || ''
  const description = sb.image_prompt || sb.imagePrompt || sb.description || ''
  const shotType = sb.shot_type || sb.shotType || ''
  const angle = sb.angle || ''
  const movement = sb.movement || ''
  const location = sb.location || getSceneName(sb)
  const time = sb.time || ''
  const charactersText = getStoryboardCharacterNames(sb).join('、')
  const action = sb.action || ''
  const atmosphere = sb.atmosphere || ''
  const frameHint = frameType === 'first_frame'
    ? '生成这个镜头的起始关键帧，突出建立关系和动作开始瞬间'
    : '生成这个镜头的结束关键帧，突出动作结束、情绪落点或结果状态'

  return [
    title ? `镜头标题：${title}` : '',
    description ? `画面描述：${description}` : '',
    shotType ? `景别：${shotType}` : '',
    angle ? `机位：${angle}` : '',
    movement ? `运镜：${movement}` : '',
    charactersText ? `角色：${charactersText}` : '',
    location ? `地点：${location}` : '',
    time ? `时间：${time}` : '',
    action ? `动作：${action}` : '',
    atmosphere ? `氛围：${atmosphere}` : '',
    frameHint,
  ].filter(Boolean).join('；')
}

function setShotFramePending(sb, frameType) {
  const key = framePendingKey(sb.id, frameType)
  if (!pendingShotFrameKeys.value.includes(key)) pendingShotFrameKeys.value.push(key)
  return key
}

function clearShotFramePending(key) {
  pendingShotFrameKeys.value = pendingShotFrameKeys.value.filter(item => item !== key)
}

function shotFrameGeneration(sb, frameType) {
  return imageGenerations.value
    .filter(generation => Number(generation?.storyboard_id || generation?.storyboardId || 0) === Number(sb?.id || 0))
    .filter(generation => String(generation?.frame_type || generation?.frameType || '') === frameType)
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] || null
}

function shotFrameError(sb, frameType) {
  const key = framePendingKey(sb?.id, frameType)
  const runtimeError = String(shotFrameRuntimeErrors.value[key] || '').trim()
  if (runtimeError) return runtimeError
  const generation = shotFrameGeneration(sb, frameType)
  if (String(generation?.status || '').toLowerCase() !== 'failed') return ''
  return generation?.error_msg || generation?.errorMsg || `${frameType === 'first_frame' ? '首帧' : '尾帧'}生成失败`
}

function shotFrameLabel(sb, frameType) {
  if (isPendingShotFrame(sb.id, frameType)) return frameType === 'first_frame' ? '首帧生成中' : '尾帧生成中'
  if (shotFrameError(sb, frameType)) return frameType === 'first_frame' ? '首帧生成失败' : '尾帧生成失败'
  return frameType === 'first_frame' ? '首帧' : '尾帧'
}

function clearShotFrameRuntimeError(key) {
  if (!shotFrameRuntimeErrors.value[key]) return
  const next = { ...shotFrameRuntimeErrors.value }
  delete next[key]
  shotFrameRuntimeErrors.value = next
}

function setShotFrameRuntimeError(key, message) {
  shotFrameRuntimeErrors.value = {
    ...shotFrameRuntimeErrors.value,
    [key]: String(message || '镜头帧图生成失败'),
  }
}

async function requestShotFrame(sb, frameType) {
  const prompt = buildShotImagePrompt(sb, frameType)
  const referenceImages = getShotReferenceImages(sb)
  const body = {
    storyboard_id: sb.id,
    drama_id: dramaId,
    config_id: effectiveImageConfigId.value || undefined,
    model: effectiveImageModel.value || undefined,
    size: isEggfansGptImage2C.value ? selectedGptImage2CSize.value : undefined,
    prompt,
    frame_type: frameType,
    reference_images: referenceImages.length ? referenceImages : undefined,
  }
  return imageAPI.generate(body)
}

async function retryShotFrame(sb, frameType) {
  const key = setShotFramePending(sb, frameType)
  const failed = shotFrameGeneration(sb, frameType)
  if (!failed?.id || String(failed.status || '').toLowerCase() !== 'failed') {
    clearShotFramePending(key)
    return genShotFrame(sb, frameType)
  }
  clearShotFrameRuntimeError(key)
  const previousFramePath = frameType === 'first_frame' ? getFirstFrame(sb) : getLastFrame(sb)
  try {
    const generation = await imageAPI.retry(failed.id, { ...imageGenerationOptions.value, episode_id: epId.value })
    toast.success(frameType === 'first_frame' ? '首帧已重新提交' : '尾帧已重新提交')
    await refresh()
    pollShotFrameGeneration(generation?.id, sb.id, frameType, key, previousFramePath)
  } catch (error) {
    clearShotFramePending(key)
    setShotFrameRuntimeError(key, error?.message || '重新提交镜头帧图失败')
    toast.error(error?.message || '重新提交镜头帧图失败')
  }
}

async function pollShotFrameGeneration(generationId, storyboardId, frameType, key, previousFramePath = '') {
  for (let i = 0; i < 120; i++) {
    await sleep(4000)
    try {
      const generation = generationId ? await imageAPI.get(generationId) : null
      await refresh()
      const target = sbs.value.find(s => s.id === storyboardId)
      const currentFramePath = frameType === 'first_frame' ? getFirstFrame(target) : getLastFrame(target)
      const completedFramePath = generation?.local_path || generation?.localPath
      if (generation?.status === 'completed' && completedFramePath) {
        clearShotFramePending(key)
        clearShotFrameRuntimeError(key)
        return
      }
      if (currentFramePath && currentFramePath !== previousFramePath) {
        clearShotFramePending(key)
        clearShotFrameRuntimeError(key)
        return
      }
      if (generation?.status === 'failed') {
        clearShotFramePending(key)
        const message = generation.error_msg || generation.errorMsg || (frameType === 'first_frame' ? '首帧生成失败' : '尾帧生成失败')
        setShotFrameRuntimeError(key, message)
        toast.error(message)
        return
      }
    } catch (error) {
      setShotFrameRuntimeError(key, error?.message || '读取镜头帧图任务状态失败')
    }
  }
  clearShotFramePending(key)
  const message = frameType === 'first_frame' ? '首帧生成超时：轮询超过 8 分钟仍未返回结果' : '尾帧生成超时：轮询超过 8 分钟仍未返回结果'
  setShotFrameRuntimeError(key, message)
  toast.error(message)
}

async function genShotFrame(sb, frameType) {
  const key = setShotFramePending(sb, frameType)
  clearShotFrameRuntimeError(key)
  const previousFramePath = frameType === 'first_frame' ? getFirstFrame(sb) : getLastFrame(sb)
  try {
    const generation = await requestShotFrame(sb, frameType)
    toast.success(frameType === 'first_frame' ? '首帧生成中' : '尾帧生成中')
    await refresh()
    pollShotFrameGeneration(generation?.id, sb.id, frameType, key, previousFramePath)
  } catch (e) {
    clearShotFramePending(key)
    setShotFrameRuntimeError(key, e?.message || (frameType === 'first_frame' ? '提交首帧生成失败' : '提交尾帧生成失败'))
    toast.error(e.message)
  }
}

function getBatchShotFrameTasks(mode) {
  const tasks = []
  for (const sb of sbs.value) {
    if ((mode === 'first_frame' || mode === 'first_last') && !getFirstFrame(sb) && !isPendingShotFrame(sb.id, 'first_frame')) {
      tasks.push({ sb, frameType: 'first_frame' })
    }
    if ((mode === 'last_frame' || mode === 'first_last') && !getLastFrame(sb) && !isPendingShotFrame(sb.id, 'last_frame')) {
      tasks.push({ sb, frameType: 'last_frame' })
    }
  }
  return tasks
}

async function batchShotFrames(mode) {
  const tasks = getBatchShotFrameTasks(mode)
  if (!tasks.length) {
    const message = mode === 'first_frame'
      ? '所有首帧已生成或正在生成'
      : mode === 'last_frame'
        ? '所有尾帧已生成或正在生成'
        : '所有首尾帧已生成或正在生成'
    toast.info(message)
    return
  }

  const pending = []
  let failedCount = 0
  for (const task of tasks) {
    const key = setShotFramePending(task.sb, task.frameType)
    pending.push({ ...task, key })
    try {
      const previousFramePath = task.frameType === 'first_frame' ? getFirstFrame(task.sb) : getLastFrame(task.sb)
      const generation = await requestShotFrame(task.sb, task.frameType)
      pollShotFrameGeneration(generation?.id, task.sb.id, task.frameType, key, previousFramePath)
    } catch (e) {
      failedCount += 1
      clearShotFramePending(key)
      toast.error(e.message)
    }
  }

  const requestedCount = pending.length - failedCount
  if (requestedCount) toast.success(`已提交 ${requestedCount} 张镜头帧图生成`)
  if (failedCount) toast.error(`${failedCount} 张镜头帧图提交失败`)
  await refresh()
}

async function genVid(sb, usePromptDraft = false) {
  const draftPrompt = hasCurrentVideoPromptDraft(sb) ? String(videoPromptDrafts.value[String(sb.id)] || '').trim() : ''
  const prompt = usePromptDraft && draftPrompt ? draftPrompt : baseStoryboardVideoPrompt(sb)
  const promptIsFinal = usePromptDraft && !!draftPrompt && isPreparedVideoPrompt(draftPrompt)
  const params = buildVideoRequestParams(sb, prompt, promptIsFinal)
  try {
    delete failedVideoMessages.value[sb.id]
    if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
    const generation = await videoAPI.generate(params)
    toast.success('视频生成中')
    await refresh()
    pollVideoGeneration(generation?.id, sb.id)
  } catch (e) {
    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
    toast.error(e.message)
  }
}

async function exportShotVideoToDesktop(sb) {
  const generation = exportableVideoGeneration(sb.id)
  if (!generation?.id) {
    toast.warning('当前镜头没有可保存的视频生成记录')
    return
  }
  const exportId = generation.id
  if (exportingVideoIds.value.includes(exportId)) return
  exportingVideoIds.value = [...exportingVideoIds.value, exportId]
  try {
    const res = await videoAPI.exportDesktop(exportId)
    const fallbackText = res?.fallback_used || res?.fallbackUsed ? '（已使用本地缓存）' : ''
    toast.success(`镜头视频已保存到桌面${fallbackText}：${res?.fileName || res?.file_name || '视频文件'}`)
  } catch (e) {
    toast.error(e.message)
  } finally {
    exportingVideoIds.value = exportingVideoIds.value.filter(id => id !== exportId)
  }
}

async function pollVideoGeneration(generationId, storyboardId) {
  if (!generationId) {
    watchAsyncResult(() => {
      const target = sbs.value.find(s => s.id === storyboardId)
      const done = !!(target?.video_url || target?.videoUrl)
      if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
      return done
    }, 60, 4000)
    return
  }
  const maxAttempts = 300
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(4000)
    try {
      const res = await videoAPI.get(generationId)
      await refresh()
      if (['pending', 'processing', 'running', 'queued'].includes(String(res?.status || '').toLowerCase())) {
        continue
      }
      if (res?.status === 'completed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        delete failedVideoMessages.value[storyboardId]
        toast.success('视频生成完成')
        return
      }
      if (res?.status === 'failed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        failedVideoMessages.value = {
          ...failedVideoMessages.value,
          [storyboardId]: res?.error_msg || res?.errorMsg || '视频生成失败',
        }
        toast.error(failedVideoMessages.value[storyboardId])
        return
      }
    } catch {}
  }
  pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
  await loadVideoGenerations()
  failedVideoMessages.value = {
    ...failedVideoMessages.value,
    [storyboardId]: '视频仍在后台生成，请稍后刷新查看结果',
  }
  toast.warning('视频仍在后台生成，请稍后刷新查看结果')
}
async function doCompose(sb) {
  try {
    delete failedComposeMessages.value[sb.id]
    if (!isPendingCompose(sb.id)) pendingComposeIds.value.push(sb.id)
    await composeAPI.shot(sb.id, composeRequestOptions.value)
    toast.success('合成完成')
    pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
    refresh()
  } catch (e) {
    pendingComposeIds.value = pendingComposeIds.value.filter(item => item !== sb.id)
    failedComposeMessages.value = {
      ...failedComposeMessages.value,
      [sb.id]: e.message,
    }
    toast.error(e.message)
  }
}
async function batchVideos() {
  const targets = batchVideoTargets.value
  if (!targets.length) {
    toast.info('当前没有可生成的视频镜头')
    return
  }

  const regenerate = isBatchVideoRegenerate.value
  let submitted = 0
  for (const sb of targets) {
    await genVid(sb)
    submitted += 1
  }
  toast.success(regenerate ? `已提交 ${submitted} 个镜头重新生成` : `已提交 ${submitted} 个镜头视频生成`)
}
async function batchCompose() {
  await composeAPI.all(epId.value, composeRequestOptions.value)
  pendingComposeIds.value = [...new Set(sbs.value.filter(sb => hasVid(sb)).map(sb => sb.id))]
  toast.success('批量合成已开始')
  pollComposeStatus()
}
async function doMerge() {
  if (mergeBusy.value || !canExport.value) return
  mergeBusy.value = true
  mergeData.value = { ...(mergeData.value || {}), status: 'processing', error_msg: '' }
  try {
    await mergeAPI.merge(epId.value)
    toast.success('拼接已开始')
    if (mergeTimer) clearInterval(mergeTimer)
    mergeTimer = setInterval(async () => {
      try {
        const next = await mergeAPI.status(epId.value)
        mergeData.value = next
        const status = String(next?.status || '').toLowerCase()
        if (status === 'completed' || status === 'failed') {
          clearInterval(mergeTimer)
          mergeTimer = null
          mergeBusy.value = false
          if (status === 'completed') {
            toast.success('拼接完成')
            await refresh()
          } else {
            toast.error(next?.error_msg || next?.errorMsg || '拼接失败')
          }
        }
      } catch (e) {
        console.error('[Merge] status polling failed', e)
      }
    }, 3000)
  } catch (e) {
    mergeBusy.value = false
    mergeData.value = { ...(mergeData.value || {}), status: 'failed', error_msg: e?.message || '拼接请求失败' }
    toast.error(`拼接失败：${e?.message || '请求失败'}`)
  }
}

async function exportMergedToDesktop() {
  if (!mergeUrl.value || exportDesktopBusy.value) return
  exportDesktopBusy.value = true
  try {
    const res = await mergeAPI.exportDesktop(epId.value)
    toast.success(`已保存到桌面：${res?.fileName || res?.file_name || '成片视频'}`)
  } catch (e) {
    toast.error(e.message)
  } finally {
    exportDesktopBusy.value = false
  }
}

async function pollComposeStatus() {
  for (let i = 0; i < 120; i++) {
    await sleep(3000)
    try {
      const res = await composeAPI.status(epId.value)
      await refresh()
      const items = Array.isArray(res?.items) ? res.items : []
      const processingIds = items.filter(item => item.status === 'compose_processing').map(item => item.id)
      pendingComposeIds.value = processingIds

      const failedItems = items.filter(item => item.status === 'compose_failed')
      if (failedItems.length) {
        const next = { ...failedComposeMessages.value }
        failedItems.forEach((item) => {
          next[item.id] = item.error_msg || item.errorMsg || '视频合成失败'
        })
        failedComposeMessages.value = next
      }

      if (!processingIds.length) {
        if (failedItems.length) toast.error(`有 ${failedItems.length} 个镜头合成失败`)
        else toast.success('批量合成完成')
        return
      }
    } catch {}
  }
}
function getRefs(sb) {
  const raw = sb.reference_images || sb.referenceImages
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.map(item => String(item || '').trim()).filter(Boolean))]
  } catch { return [] }
}

async function loadConfigs() {
  try {
    const [imgCfgs, vidCfgs, audCfgs] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('audio'),
    ])
    imageConfigs.value = imgCfgs || []
    videoConfigs.value = vidCfgs || []
    audioConfigs.value = audCfgs || []
    if (!modelPreferencesHydrated) await restoreModelPreferences()
  } catch (e) { console.error('Failed to load AI configs', e) }
}

async function loadStoryboardAgentRuntime() {
  try {
    const data = await agentAPI.debug('storyboard_breaker')
    storyboardAgentRuntime.value = data?.runtime || null
  } catch (e) {
    console.error('Failed to load storyboard agent runtime', e)
    storyboardAgentRuntime.value = null
  }
}

function inferVoiceGender(name, desc = []) {
  const text = `${name} ${Array.isArray(desc) ? desc.join(' ') : ''}`
  if (/[男|青年|大爷|学长|boy|man|male]/i.test(text)) return '男声'
  if (/[女|少女|御姐|奶奶|girl|woman|female]/i.test(text)) return '女声'
  return '中性'
}

function mapVoiceProfile(v) {
  const desc = Array.isArray(v.description) ? v.description : []
  return {
    id: v.voice_id,
    label: v.voice_name || v.voice_id,
    gender: inferVoiceGender(v.voice_name || v.voice_id, desc),
    traits: desc.length ? desc.slice(0, 2).join('、') : `${v.language || '多语言'}音色`,
    suitable: desc.length > 2 ? desc.slice(2).join('、') : `${v.language || '通用'}角色`,
  }
}

async function loadVoices() {
  try {
    const provider = effectiveAudioConfig.value?.provider || 'minimax'
    const rows = await voicesAPI.list(provider)
    voiceProfiles.value = rows?.length ? rows.map(mapVoiceProfile) : fallbackVoiceProfiles
  } catch (e) {
    console.error('Failed to load voices', e)
    voiceProfiles.value = fallbackVoiceProfiles
  }
}

watch([effectiveAudioConfigId, audioConfigs], () => { loadVoices() }, { deep: true })
onMounted(() => { refresh(); loadConfigs(); loadVoices(); loadStoryboardAgentRuntime() })
</script>

<style scoped>
/* ===== Studio Layout ===== */
.studio {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  padding: 14px;
  gap: 12px;
  background:
    radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 28%),
    linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0)),
    var(--bg-base);
}

.studio-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-radius: 18px;
  background: rgba(252, 253, 255, 0.84);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 14px 36px rgba(20, 32, 54, 0.07), 0 3px 10px rgba(20, 32, 54, 0.04);
  backdrop-filter: blur(16px);
}

.studio-topbar-main,
.sidebar,
.main {
  background: rgba(252, 253, 255, 0.84);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 18px 48px rgba(20, 32, 54, 0.08), 0 4px 14px rgba(20, 32, 54, 0.05);
  backdrop-filter: blur(16px);
}

.studio-topbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: transparent;
  min-width: 0;
}

.topbar-back {
  width: auto;
  min-width: 76px;
  padding: 0 8px;
  height: 28px;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 11px;
}

.studio-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.studio-overline {
  display: none;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.studio-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.studio-title {
  font-size: 14px;
  line-height: 1;
  letter-spacing: -0.04em;
  white-space: nowrap;
}

.studio-episode-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  color: var(--accent-text);
  font-size: 9px;
  font-weight: 700;
}

.studio-meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  min-width: 0;
}

.studio-meta-pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.05);
  color: var(--text-2);
  font-size: 8px;
  font-weight: 600;
  white-space: nowrap;
}

.studio-meta-pill.is-stage {
  background: rgba(19, 51, 121, 0.08);
  color: var(--accent-text);
}
.studio-meta-pill.is-progress {
  background: rgba(45, 122, 69, 0.08);
  color: var(--success);
}
.studio-meta-inline {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 600;
  white-space: nowrap;
}

.studio-topbar-side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.studio-actions {
  display: flex;
  gap: 6px;
}
.dubbing-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 4px 8px;
  border: 1px solid rgba(27, 41, 64, 0.1);
  border-radius: 8px;
  background: rgba(255,255,255,0.82);
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.dubbing-switch input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
}
.dubbing-switch-copy {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
  font-size: 10px;
}
.dubbing-switch-copy strong { color: var(--text-1); font-size: 11px; }
.dubbing-switch-copy span { color: var(--text-3); }
.studio-dubbing-switch { margin-left: 2px; }
.episode-dubbing-switch { margin-top: 12px; }
.studio-topbar .btn {
  height: 28px;
  padding: 0 10px;
  font-size: 11px;
  white-space: nowrap;
}

.studio-body {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  flex: 1;
}

/* ===== Sidebar ===== */
.sidebar {
  width: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  border-radius: 28px;
}
.back-btn {
  width: 40px; height: 40px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(27, 41, 64, 0.1); border-radius: 14px;
  background: rgba(255,255,255,0.8); color: var(--text-2);
  cursor: pointer; transition: all 0.15s;
  box-shadow: var(--shadow-xs);
}
.back-btn:hover { background: #fff; color: var(--text-0); }

/* Pipeline Nav */
.pipeline { flex: 1; overflow-y: auto; padding: 16px 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.pipe-section { display: flex; flex-direction: column; gap: 4px; }
.pipe-section-label {
  font-size: 10px; font-weight: 700; color: #95a1b6;
  text-transform: uppercase; letter-spacing: 0.1em;
  padding: 2px 8px 3px;
}
.pipe-item {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 7px 10px;
  border-radius: 17px;
  font-size: 12px; font-weight: 600;
  background: none; border: 1px solid transparent; color: var(--text-2); cursor: pointer;
  transition: all 0.14s; width: 100%; text-align: left;
}
.pipe-item:hover { background: rgba(255,255,255,0.3); color: var(--text-0); }
.pipe-item.active {
  background: rgba(255,255,255,0.94);
  color: var(--text-0);
  border-color: rgba(27, 41, 64, 0.05);
  box-shadow: 0 8px 18px rgba(19, 33, 56, 0.045);
}
.pipe-item.done { color: var(--success); }
.pipe-item-sub {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  padding: 7px 10px;
  position: relative;
  min-height: 42px;
}

.pipe-item-sub:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 18px;
  top: 25px;
  bottom: -7px;
  width: 1px;
  background: rgba(27, 41, 64, 0.07);
}

.pipe-icon {
  width: 17px; height: 17px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(246,248,252,0.98); border: 1px solid rgba(18,25,42,0.08);
  color: #aab4c6; flex-shrink: 0; transition: all 0.15s;
  position: relative;
  z-index: 1;
}
.pipe-item.active .pipe-icon { background: rgba(19, 51, 121, 0.07); border-color: rgba(19, 51, 121, 0.1); color: var(--accent-text); }
.pipe-item.done .pipe-icon { background: rgba(45, 122, 69, 0.96); border-color: rgba(45,122,69,0.18); color: #fff; }
.icon-active { background: var(--accent-dark) !important; border-color: var(--accent-dark) !important; color: #fff !important; }
.icon-done { background: var(--success) !important; border-color: var(--success) !important; color: #fff !important; }

.pipe-label { flex: 1; font-size: 11.5px; }
.pipe-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pipe-sub {
  font-size: 8.5px;
  line-height: 1.35;
  color: var(--text-3);
  font-weight: 500;
}
.pipe-badge {
  font-size: 9px; font-weight: 700; padding: 1px 5px;
  border-radius: 99px; background: var(--bg-3); color: var(--text-3);
  font-family: var(--font-mono);
}
.pipe-badge.badge-done { background: var(--success-bg); color: var(--success); }
.pipe-spinner { width: 10px; height: 10px; border: 1.5px solid var(--accent-bg); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* Sidebar Bottom */
.sidebar-bottom {
  padding: 12px 14px 14px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  display: flex; flex-direction: column; gap: 8px;
  flex-shrink: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.72));
}
.sidebar-jumper {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 3px 0 2px;
}
.sidebar-jump-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: none;
  background: rgba(45, 122, 69, 0.22);
  cursor: pointer;
  transition: transform 0.14s, background 0.14s, box-shadow 0.14s;
}
.sidebar-jump-dot:hover {
  transform: scale(1.08);
}
.sidebar-jump-dot.active {
  background: var(--accent-dark);
  box-shadow: 0 0 0 2px rgba(76, 125, 255, 0.14);
}
.sidebar-jump-dot.done {
  background: var(--success);
}
.sidebar-jump-dot.active.done {
  background: #1e3f8a;
}
.progress-wrap { display: flex; flex-direction: column; gap: 5px; }
.progress-head { display: flex; justify-content: space-between; }
.progress-label { font-size: 10.5px; color: var(--text-3); font-weight: 500; }
.progress-val { font-size: 10.5px; color: var(--text-2); font-family: var(--font-mono); font-weight: 600; }
.progress-track { height: 6px; background: rgba(194, 207, 227, 0.92); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent-gradient); border-radius: 99px; transition: width 0.5s var(--ease-out); }
.refresh-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px; font-size: 11.5px; color: var(--text-2);
  background: rgba(255,255,255,0.86); border: 1px solid rgba(27, 41, 64, 0.08); border-radius: 999px;
  cursor: pointer; transition: all 0.15s;
}
.refresh-btn:hover { background: #fff; color: var(--text-0); }

/* ===== Main Content ===== */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; border-radius: 30px; }
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
.stage-subnav {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.52));
  overflow-x: auto;
  flex-shrink: 0;
}
.stage-subnav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.7);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s ease;
}
.stage-subnav-item:hover {
  background: #fff;
  color: var(--text-0);
}
.stage-subnav-item.active {
  background: rgba(19, 51, 121, 0.08);
  border-color: rgba(19, 51, 121, 0.12);
  color: #1e3f8a;
}
.stage-subnav-item.done {
  color: var(--text-1);
}
.stage-subnav-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 0 4px rgba(45, 122, 69, 0.1);
}

/* Toolbar */
.step-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 14px; border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(255,255,255,0.42)); flex-shrink: 0;
}
.prod-toolbar { background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(255,255,255,0.42)); }
.toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.video-sequence-panel {
  display: grid;
  gap: 8px;
  margin: 0 12px 12px;
  padding: 12px 14px;
  border: 1px solid rgba(34, 79, 156, 0.14);
  border-radius: 8px;
  background: rgba(245, 249, 255, 0.9);
}
.video-sequence-head,
.video-sequence-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.video-sequence-head { justify-content: space-between; }
.video-sequence-head > div:first-child { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.video-sequence-progress { height: 6px; overflow: hidden; border-radius: 3px; background: rgba(27, 41, 64, 0.08); }
.video-sequence-progress span { display: block; height: 100%; background: var(--accent); transition: width 0.25s ease; }
.video-sequence-note,
.video-sequence-step-detail { font-size: 11px; color: var(--text-2); line-height: 1.5; overflow-wrap: anywhere; }
.video-sequence-assets { display: flex; gap: 6px; flex-wrap: wrap; }
.sequence-error { display: block; margin-top: 4px; color: var(--danger); }
.step-indicator { display: flex; align-items: center; gap: 8px; }
.step-num {
  width: 26px; height: 26px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(19, 51, 121, 0.08);
  font-family: var(--font-mono); font-size: 10px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 13px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Editor Area */
.step-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.fill-textarea {
  flex: 1; border: none; border-radius: 0; padding: 26px 28px;
  font-size: 13.5px; line-height: 1.9; resize: none; outline: none;
  font-family: var(--font-body); background: linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.12)); color: var(--text-0);
}
.fill-textarea:focus { box-shadow: none; }

/* Step Empty State */
.step-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; min-height: 300px; gap: 10px; padding: 46px;
  animation: fadeIn 0.3s var(--ease-out);
}
.empty-visual {
  width: 72px; height: 72px; border-radius: 22px;
  background: rgba(255,255,255,0.8); color: var(--accent);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: var(--shadow-sm);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.empty-title { font-size: 22px; font-weight: 700; font-family: var(--font-display); color: var(--text-0); }
.empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.8; }
.step-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Step Loading */
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }

/* Step Navigator Bubble */
.step-bubble {
  position: static;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px 12px;
  background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.58));
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  margin-top: auto;
}
.bubble-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 999px; font-size: 11.5px; font-weight: 500;
  border: 1px solid rgba(27, 41, 64, 0.08); background: rgba(255,255,255,0.84); color: var(--text-2); cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.bubble-btn:hover:not(:disabled) { background: #fff; color: var(--text-0); }
.bubble-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.bubble-btn.primary { margin-left: auto; background: linear-gradient(135deg, #557ff4, #345fcc); color: #fff; box-shadow: 0 6px 16px rgba(53, 95, 206, 0.2); border-color: transparent; }
.bubble-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.bubble-btn.primary:disabled { filter: none; box-shadow: none; opacity: 0.5; }
.bubble-dots { display: flex; gap: 7px; padding: 0 4px; }
.bubble-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: rgba(143, 160, 184, 0.4); cursor: pointer; transition: all 0.15s;
  border: none;
}
.bubble-dot.done { background: var(--success); }
.bubble-dot.current { background: var(--accent-dark); transform: scale(1.2); box-shadow: 0 0 0 2px rgba(76, 125, 255, 0.14); }

/* Extract grid */
.extract-stage { flex: 1; min-height: 0; overflow: hidden; padding: 12px 16px; display: grid; grid-template-columns: 280px minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
.extract-summary { padding: 16px; display: flex; flex-direction: column; gap: 14px; align-self: stretch; position: sticky; top: 0; max-height: 100%; }
.extract-summary-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3); }
.extract-summary-title { font-size: 20px; line-height: 1.05; font-family: var(--font-display); color: var(--text-0); }
.extract-summary-desc { font-size: 12px; color: var(--text-2); line-height: 1.7; }
.extract-summary-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.extract-summary-stat { padding: 10px 12px; border-radius: 14px; background: rgba(19, 51, 121, 0.05); border: 1px solid rgba(19, 51, 121, 0.08); display: flex; flex-direction: column; gap: 4px; }
.extract-summary-stat span { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
.extract-summary-stat strong { font-size: 18px; color: var(--text-0); font-family: var(--font-display); }
.extract-summary-note { padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,0.56); border: 1px solid rgba(27, 41, 64, 0.08); font-size: 11px; line-height: 1.7; color: var(--text-2); }
.extract-card { overflow: hidden; min-height: 0; display: flex; flex-direction: column; }
.extract-card-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; font-size: 12px; font-weight: 600;
  border-bottom: 1px solid var(--border); background: var(--bg-1);
  color: var(--text-1);
}
.extract-list { padding: 8px 14px; flex: 1; min-height: 0; overflow-y: auto; }
.extract-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.extract-row + .extract-row { border-top: 1px solid var(--border); }
.char-avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--accent-bg); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; flex-shrink: 0;
}
.scene-icon {
  width: 30px; height: 30px; border-radius: 6px;
  background: var(--bg-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3); flex-shrink: 0;
}
.extract-info { min-width: 0; }
.extract-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.extract-name { font-size: 13px; font-weight: 600; }
.extract-meta { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.extract-meta.wrap { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

/* Voice grid */
.voice-stage { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 12px; }
.voice-stage-panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-self: start;
  position: sticky;
  top: 0;
  min-height: 0;
  max-height: calc(100vh - 210px);
  overflow: hidden;
}
.voice-stage-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3); }
.voice-stage-title { font-size: 20px; line-height: 1.05; font-family: var(--font-display); color: var(--text-0); }
.voice-stage-desc { font-size: 12px; color: var(--text-2); line-height: 1.7; }
.voice-stage-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.voice-stage-stat { padding: 10px 12px; border-radius: 14px; background: rgba(19, 51, 121, 0.05); border: 1px solid rgba(19, 51, 121, 0.08); display: flex; flex-direction: column; gap: 3px; }
.voice-stage-stat-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
.voice-stage-stat strong { font-size: 18px; color: var(--text-0); font-family: var(--font-display); }
.voice-library-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
}
.voice-library {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.voice-library-item { padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,0.56); border: 1px solid rgba(27, 41, 64, 0.08); display: flex; flex-direction: column; gap: 4px; }
.voice-library-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-library-name { font-size: 13px; font-weight: 700; color: var(--text-0); }
.voice-library-traits { font-size: 11px; color: var(--text-1); }
.voice-library-fit { font-size: 10px; color: var(--text-3); line-height: 1.5; }

.voice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; align-content: start; }
.voice-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; border-radius: 22px; min-height: 0; }
.voice-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.voice-char { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.voice-name { min-width: 0; flex: 1; }
.voice-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.voice-card-copy { min-height: 58px; }
.voice-card-text { font-size: 12px; line-height: 1.7; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.voice-select-block { display: flex; flex-direction: column; gap: 6px; }
.voice-block-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); }
.voice-profile-card { padding: 12px; border-radius: 16px; background: linear-gradient(135deg, rgba(19, 51, 121, 0.08), rgba(255,255,255,0.78)); border: 1px solid rgba(19, 51, 121, 0.1); display: flex; flex-direction: column; gap: 4px; }
.voice-profile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-profile-name { font-size: 13px; font-weight: 700; color: var(--accent-text); }
.voice-profile-traits { font-size: 11px; color: var(--text-1); }
.voice-profile-fit { font-size: 10px; color: var(--text-2); line-height: 1.5; }
.voice-actions-row { display: flex; align-items: center; gap: 8px; }
.voice-player audio { width: 100%; height: 30px; border-radius: var(--radius); }
.char-avatar.lg { width: 38px; height: 38px; font-size: 16px; }

/* Split layout (storyboard) */
.split-layout { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.shot-list { width: 296px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg-0); }
.shot-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.06);
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(10px);
}
.shot-list-title { font-size: 13px; font-weight: 700; color: var(--text-0); }
.shot-list-sub { margin-top: 3px; font-size: 11px; color: var(--text-3); line-height: 1.45; }
.shot-list-body { padding: 6px; }
.shot-item {
  position: relative; padding: 10px 11px; cursor: pointer;
  border: 1px solid transparent; border-left: 3px solid transparent;
  transition: all 0.15s;
  display: flex; flex-direction: column; gap: 5px;
  border-radius: 14px;
}
.shot-item + .shot-item { margin-top: 6px; }
.shot-item:hover { background: var(--bg-hover); border-color: rgba(27, 41, 64, 0.06); }
.shot-item.active {
  background: var(--bg-0);
  border-left-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-glow);
  z-index: 1;
}
.shot-item-header { display: flex; align-items: center; gap: 8px; }
.shot-num {
  font-size: 11px; font-family: var(--font-mono); font-weight: 700;
  color: var(--accent); background: var(--accent-bg);
  padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
  letter-spacing: 0.03em;
}
.shot-item.active .shot-num { background: var(--accent); color: #fff; }
.shot-status { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
.shot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.shot-dot.has-img { background: var(--success); }
.shot-dot.has-video { background: var(--info); }
.shot-dot.has-dialogue { background: var(--warning); }
.shot-body { }
.shot-desc { font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-1); }
.shot-item.active .shot-desc { color: var(--text-0); }
.shot-meta { display: flex; align-items: center; gap: 6px; }
.shot-location {
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-dialogue {
  font-size: 10px; color: var(--text-3); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-left: 2px; border-left: 2px solid var(--border);
  padding-left: 6px;
}

.detail-panel { flex: 1; display: flex; flex-direction: column; overflow-y: auto; min-width: 0; }
.detail-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-head-copy { display: flex; flex-direction: column; gap: 2px; }
.detail-head-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.detail-head-sub { font-size: 11px; color: var(--text-3); }
.detail-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.detail-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.9fr);
  gap: 12px;
  padding: 12px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(20,39,82,0.08), rgba(255,255,255,0.68));
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-hero-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.detail-hero-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--text-3);
}
.detail-hero-text { font-size: 13px; color: var(--text-1); line-height: 1.7; }
.detail-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.detail-preview-card { display: flex; flex-direction: column; gap: 6px; }
.detail-preview-title { font-size: 11px; font-weight: 700; color: var(--text-2); }
.detail-preview-media {
  position: relative; aspect-ratio: 16/9; overflow: hidden;
  border-radius: 14px; background: rgba(18,25,42,0.08);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-preview-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.detail-preview-empty {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: 12px;
}
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-section-title { font-size: 12px; font-weight: 700; color: var(--text-0); }
.detail-section-copy { font-size: 11px; color: var(--text-3); }

/* Field */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-row { display: flex; gap: 12px; }
.field-grid { display: grid; gap: 12px; }
.field-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.locked-config {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  border: 1px solid rgba(19, 51, 121, 0.12);
  color: var(--text-1);
  font-size: 11px;
  font-weight: 600;
}
.storyboard-config-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.locked-config-subtle {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.14);
  color: var(--text-2);
}
.storyboard-config-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  margin-bottom: 8px;
}
.locked-config-banner {
  font-size: 12px;
  color: var(--text-2);
}
.locked-config-banner.is-subtle {
  color: var(--text-3);
}
.breakdown-empty-config {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin: 2px 0 8px;
}
.breakdown-mode {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(27, 41, 64, 0.1);
  border-radius: 8px;
  background: rgba(255,255,255,0.78);
}
.breakdown-mode-option {
  height: 26px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.breakdown-mode-option.active {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 12px rgba(29, 77, 176, 0.16);
}
.breakdown-hint {
  max-width: 420px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}

.breakdown-error {
  display: flex;
  max-width: 620px;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #dc2626 35%, var(--border));
  border-radius: 6px;
  color: #b91c1c;
  background: color-mix(in srgb, #fee2e2 55%, var(--card));
  font-size: 12px;
  line-height: 1.55;
}

.breakdown-error strong {
  flex: 0 0 auto;
}

.loading-detail {
  color: var(--muted-foreground);
  font-size: 12px;
}
.role-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.role-pill {
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(27, 41, 64, 0.12);
  background: rgba(255,255,255,0.86);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.role-pill:hover { border-color: var(--accent); color: var(--text-0); }
.role-pill.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: 0 8px 18px rgba(29, 77, 176, 0.18);
}

/* Production tabs */
.prod-tabs { display: flex; gap: 0; background: var(--bg-2); border-radius: var(--radius); padding: 2px; }
.prod-tab {
  display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 12px;
  border: none; background: transparent; color: var(--text-2); cursor: pointer;
  border-radius: calc(var(--radius) - 2px); transition: all 0.15s; font-weight: 500;
}
.prod-tab:hover { color: var(--text-0); }
.prod-tab.active { background: var(--bg-0); color: var(--text-0); font-weight: 600; box-shadow: var(--shadow-xs); }
.prod-tab-badge { font-size: 10px; font-family: var(--font-mono); padding: 0 4px; background: var(--bg-3); border-radius: 99px; }
.prod-tab.active .prod-tab-badge { background: var(--accent-bg); color: var(--accent-text); }

/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.prod-section-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.compose-audio-mode {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(27, 41, 64, 0.1);
  border-radius: 8px;
  background: rgba(255,255,255,0.78);
}
.compose-audio-option {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.compose-audio-option.active {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 6px 14px rgba(29, 77, 176, 0.16);
}

.dub-grid { display: flex; flex-direction: column; gap: 10px; }
.dub-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; border-radius: 20px; background: linear-gradient(180deg, rgba(255,255,255,0.74), rgba(248,251,255,0.58)); }
.dub-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.dub-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.dub-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-desc { font-size: 13px; line-height: 1.6; color: var(--text-1); }
.dub-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; }
.dub-error { padding: 8px 10px; border-radius: 10px; background: var(--error-bg); color: var(--error); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.dub-foot { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid rgba(27, 41, 64, 0.08); }
.dub-audio { flex: 1; min-width: 0; height: 30px; }

/* Asset grid */
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.asset-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.asset-card:hover { transform: translateY(-2px); box-shadow: 0 16px 30px rgba(20, 32, 54, 0.08); }
.asset-cover { position: relative; aspect-ratio: 1; background: var(--bg-2); overflow: hidden; }
.asset-cover.wide { aspect-ratio: 16/9; }
.asset-cover img { width: 100%; height: 100%; object-fit: cover; }
.previewable-image { cursor: zoom-in; transition: transform 0.18s var(--ease-out), filter 0.18s var(--ease-out); }
.previewable-image:hover { transform: scale(1.015); filter: saturate(1.04); }
.asset-cover-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(7,11,21,0.58);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
.asset-cover-badge.is-ready {
  background: rgba(36, 125, 72, 0.92);
}
.asset-cover-badge.is-pending {
  background: rgba(19, 51, 121, 0.92);
}
.asset-cover-badge.is-failed {
  background: rgba(142, 45, 45, 0.94);
}
.asset-generation-error {
  display: block;
  margin-top: 5px;
  color: var(--error);
  font-size: 10px;
  line-height: 1.35;
  max-height: 30px;
  overflow: hidden;
}
.asset-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.asset-body { padding: 8px 10px; }
.asset-name { font-size: 13px; font-weight: 600; }
.asset-meta { font-size: 11px; }
.asset-volc-line {
  margin-top: 7px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.asset-volc-line .tag {
  padding: 1px 5px;
  font-size: 9px;
}
.asset-volc-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-3);
}
.asset-foot { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.asset-foot .btn { padding: 3px 7px; font-size: 10px; }

/* Frame grid */
.frame-grid { display: flex; flex-direction: column; gap: 8px; }
.frame-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; cursor: pointer;
  border-radius: var(--radius-lg);
  transition: all 0.15s;
  border: 1.5px solid transparent;
}
.frame-row:hover { background: var(--bg-0); border-color: var(--border); }
.frame-row.active {
  background: var(--bg-0);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.frame-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.frame-top { display: flex; align-items: center; gap: 8px; }
.frame-num {
  font-size: 13px; font-family: var(--font-mono); font-weight: 800;
  color: var(--accent);
}
.frame-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 20px;
  background: var(--accent-bg); color: var(--accent);
  border: 1px solid var(--accent-glow);
  white-space: nowrap;
}
.frame-desc {
  font-size: 12px; line-height: 1.5; color: var(--text-1);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.frame-meta { display: flex; align-items: center; gap: 6px; }
.frame-thumbs { display: flex; gap: 8px; flex-shrink: 0; }
.frame-thumb-wrap { display: flex; flex-direction: column; gap: 3px; align-items: center; }
.frame-thumb-label { font-size: 10px; font-weight: 600; color: var(--text-3); }
.frame-generation-error {
  width: 130px;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  color: var(--danger);
  font-size: 10px;
  line-height: 1.35;
  text-align: left;
}
.frame-generation-error > span {
  min-width: 0;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.frame-generation-retry {
  flex: 0 0 auto;
  border: 0;
  padding: 0;
  color: var(--accent);
  background: transparent;
  cursor: pointer;
  font-size: 10px;
  white-space: nowrap;
}
.frame-generation-retry:hover { text-decoration: underline; }
.frame-thumb {
  position: relative; width: 130px; aspect-ratio: 16/9;
  border-radius: 6px; overflow: hidden;
  background: var(--bg-2); cursor: pointer;
  transition: all 0.15s; border: 1.5px solid var(--border);
}
.frame-thumb:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.frame-thumb img { width: 100%; height: 100%; object-fit: cover; }
.frame-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.frame-ref-strip {
  display: grid;
  grid-template-columns: repeat(4, 44px);
  gap: 5px;
}
.frame-ref-thumb {
  position: relative;
  width: 44px;
  aspect-ratio: 1;
  border: 1.5px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  overflow: hidden;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
}
.frame-ref-thumb:hover {
  border-color: var(--accent);
}
.frame-ref-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.frame-ref-thumb.add {
  display: flex;
  align-items: center;
  justify-content: center;
}
.frame-ref-more {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(14, 19, 28, 0.62);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
}
.frame-ref-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 16px;
}
.frame-ref-add-link {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}
.frame-ref-add-link:hover {
  text-decoration: underline;
}
.frame-re {
  position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff;
  display: none; align-items: center; justify-content: center;
}
.frame-thumb:hover .frame-re { display: flex; }
.frame-scroll { flex: 1; overflow-y: auto; padding: 10px 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(76, 125, 255, 0.14);
}

/* Prod grid */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; min-width: 0; }
.prod-grid-videos { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); align-items: start; }
.prod-card {
  display: flex; flex-direction: column; overflow: hidden; min-width: 0;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255,255,255,0.74), rgba(248,251,255,0.58));
}
.prod-card:hover { transform: translateY(-2px); box-shadow: 0 16px 30px rgba(20, 32, 54, 0.08); }
.prod-cover { position: relative; aspect-ratio: 16/9; background: var(--bg-2); overflow: hidden; }
.prod-cover img { width: 100%; height: 100%; object-fit: cover; }
.prod-video { width: 100%; height: 100%; object-fit: cover; background: #000; display: block; }
.video-preview-btn {
  position: absolute;
  right: 8px;
  bottom: 8px;
  border: 1px solid rgba(255,255,255,0.32);
  border-radius: 999px;
  padding: 4px 9px;
  background: rgba(10, 14, 22, 0.7);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  backdrop-filter: blur(8px);
}
.video-preview-btn:hover {
  background: rgba(10, 14, 22, 0.86);
}
.prod-ref-grid {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  background: rgba(14, 19, 28, 0.06);
}
.prod-ref-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  grid-template-rows: 1fr;
}
.prod-ref-tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 0;
  padding: 0;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-3);
  cursor: zoom-in;
}
.prod-ref-tile img {
  display: block;
}
.prod-ref-more {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(14, 19, 28, 0.62);
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}
.prod-ref-badge {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(14, 19, 28, 0.68);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
.prod-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.prod-idx {
  position: absolute; top: 5px; left: 5px; font-size: 10px; font-weight: 700;
  font-family: var(--font-mono); background: rgba(0,0,0,0.5); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-overlay-badge {
  position: absolute; bottom: 5px; right: 5px; font-size: 10px; font-weight: 600;
  background: var(--success); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-info { padding: 10px 12px 8px; min-width: 0; }
.prod-desc { font-size: 12px; line-height: 1.4; }
.prod-meta-line { margin-top: 5px; font-size: 10px; color: var(--text-3); }
.prod-dots { display: flex; align-items: center; gap: 4px; margin-top: 5px; color: var(--text-3); flex-wrap: wrap; min-width: 0; }
.prod-error {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.volc-ref-panel {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: var(--radius);
  background: rgba(250, 252, 255, 0.72);
}
.volc-ref-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  min-width: 0;
}
.volc-ref-head .btn {
  margin-left: auto;
  flex-shrink: 0;
  padding: 3px 7px;
  font-size: 10px;
}
.volc-ref-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.volc-ref-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.volc-ref-thumb {
  width: 34px;
  height: 34px;
  border: 0;
  padding: 0;
  border-radius: 5px;
  overflow: hidden;
  background: var(--bg-3);
  cursor: zoom-in;
}
.volc-ref-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.volc-ref-body {
  min-width: 0;
}
.volc-ref-title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 10px;
  color: var(--text-2);
}
.volc-ref-title > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.volc-ref-title .tag {
  padding: 1px 5px;
  font-size: 9px;
  flex-shrink: 0;
}
.volc-ref-id {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-3);
}
.volc-ref-row > .btn {
  padding: 3px 7px;
  font-size: 10px;
}
.video-prompt-panel {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.74);
  min-width: 0;
}
.video-prompt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  min-width: 0;
  flex-wrap: wrap;
}
.video-prompt-head .btn {
  margin-left: auto;
  padding: 3px 7px;
  font-size: 10px;
  flex-shrink: 0;
}
.video-prompt-editor {
  margin-top: 7px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.video-prompt-textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  min-height: 160px;
  resize: vertical;
  border: 1px solid rgba(27, 41, 64, 0.12);
  border-radius: 8px;
  padding: 8px;
  background: rgba(250, 252, 255, 0.92);
  color: var(--text-1);
  font-size: 11px;
  line-height: 1.55;
  font-family: var(--font-mono);
}
.video-prompt-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.video-prompt-actions .btn {
  flex: 1 1 96px;
  justify-content: center;
  padding: 4px 8px;
  font-size: 10px;
  min-width: 0;
  white-space: normal;
  line-height: 1.25;
}
.prod-actions { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid rgba(27, 41, 64, 0.08); flex-wrap: wrap; min-width: 0; }
.prod-actions .btn { flex: 1 1 92px; justify-content: center; min-width: 0; white-space: normal; line-height: 1.25; }

.character-material-dialog {
  width: min(620px, calc(100vw - 40px));
  max-height: min(720px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.character-material-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
}
.character-material-title { font-size: 16px; font-weight: 700; color: var(--text-0); }
.character-material-subtitle { margin-top: 4px; font-size: 12px; }
.character-material-list { display: flex; flex-direction: column; gap: 8px; padding: 14px 20px 20px; overflow-y: auto; }
.character-material-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-1);
}
.character-material-thumb {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 8px;
  color: var(--text-3);
  background: var(--bg-2);
}
.character-material-thumb img { width: 100%; height: 100%; object-fit: cover; }
.character-material-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.character-material-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-0); font-size: 13px; }
.character-material-copy span { color: var(--text-3); font-size: 11px; }

/* Image viewer */
.image-viewer-overlay {
  z-index: 120;
  padding: 28px;
  background: rgba(18, 24, 34, 0.68);
  backdrop-filter: blur(10px);
}
.image-viewer-dialog {
  width: min(1100px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,251,255,0.92));
}
.image-viewer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}
.image-viewer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.image-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.image-viewer-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(8, 14, 24, 0.22);
  background: rgba(255,255,255,0.9);
}
.video-viewer-overlay {
  padding: 18px;
}
.video-viewer-dialog {
  width: min(1440px, calc(100vw - 36px));
  height: calc(100vh - 36px);
  max-height: calc(100vh - 36px);
  border-radius: 18px;
  background: rgba(9, 13, 22, 0.96);
}
.video-viewer-dialog .image-viewer-head {
  border-bottom-color: rgba(255,255,255,0.12);
}
.video-viewer-dialog .image-viewer-title {
  color: #fff;
}
.video-viewer-body {
  flex: 1;
  padding: 0;
  background: #000;
  overflow: hidden;
}
.video-viewer-player {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

/* Grid tool dialog */
.grid-tool { width: min(1320px, calc(100vw - 40px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column; overflow: hidden; animation: scaleIn 0.2s var(--ease-out); }
.grid-tool-head { display: flex; align-items: center; gap: 8px; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.grid-tool-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.grid-tool-body-preview { overflow: hidden; min-height: 0; padding-bottom: 10px; }
.grid-tool-foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 4px; }
.grid-preview-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.72fr) minmax(340px, 400px);
  gap: 14px;
  min-height: 0;
  flex: 1;
  align-items: start;
}
.grid-preview-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.grid-assignment-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 18px;
  background: rgba(255,255,255,0.66);
  overflow: hidden;
  max-height: min(70vh, 840px);
}
.grid-assign-head {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(255,255,255,0.72));
}
.grid-assign-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.grid-assign-subtitle {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}
.grid-assign-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.86);
}
.grid-assign-columns {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 96px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(246, 248, 252, 0.92);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Prompt preview */
.grid-prompt-summary { background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.grid-prompt-label { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.grid-prompt-text { font-size: 12px; color: var(--text-1); line-height: 1.7; }
.grid-status-note {
  border: 1px solid rgba(201, 88, 68, 0.22);
  background: rgba(255, 246, 243, 0.9);
  color: var(--text-1);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
}

.grid-blank-preview {
  display: grid;
  gap: 4px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 8px;
  min-height: 200px;
}
.grid-blank-cell {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 70px;
}
.grid-blank-cell.empty { opacity: 0.4; }
.grid-blank-cell-index { font-size: 10px; font-weight: 700; color: var(--accent); font-family: var(--font-mono); }
.grid-blank-cell-desc { font-size: 11px; color: var(--text-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.grid-mode-tabs { display: flex; gap: 6px; }
.grid-mode-tab { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1.5px solid var(--border); border-radius: var(--radius); background: var(--bg-0); cursor: pointer; transition: all 0.15s; text-align: left; }
.grid-mode-tab:hover { border-color: var(--border-strong); }
.grid-mode-tab.active { border-color: var(--accent); background: var(--accent-bg); }
.grid-config { display: flex; gap: 12px; align-items: flex-end; }
.grid-pick-list { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px; }
.grid-pick-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; transition: background 0.1s; }
.grid-pick-item:hover { background: var(--bg-hover); }
.grid-pick-item.selected { background: var(--accent-bg); }
.grid-pick-item input { accent-color: var(--accent); }
.grid-preview-wrap {
  border-radius: var(--radius);
  overflow: auto;
  border: 1px solid var(--border);
  background: rgba(14, 19, 28, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  max-height: min(70vh, 860px);
  padding: 10px;
}
.grid-preview-stage {
  position: relative;
  width: fit-content;
  max-width: 100%;
  margin: auto;
  line-height: 0;
}
.grid-preview-img {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: min(66vh, 820px);
  object-fit: contain;
}
.grid-overlay { position: absolute; inset: 0; display: grid; }
.grid-overlay-cell {
  border: 1px dashed rgba(255,255,255,0.42);
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 4px 6px;
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.grid-overlay-cell.active {
  background: rgba(255,255,255,0.08);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.28);
}
.grid-cell-label { font-size: 10px; font-weight: 700; color: #fff; background: rgba(0,0,0,0.5); padding: 1px 5px; border-radius: 3px; }
.grid-adjust-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 2px; }
.grid-assign-info {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 4px 12px 10px;
}
.grid-assign-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 112px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(27, 41, 64, 0.08);
}
.grid-assign-row.active {
  background: rgba(32, 86, 190, 0.05);
  border-radius: 12px;
  padding-left: 6px;
  padding-right: 6px;
}
.grid-assign-row:last-child { border-bottom: 0; }
.grid-assign-index {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.grid-assign-bind {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.45;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-history-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.64));
}
.grid-history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.grid-history-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.grid-history-subtitle {
  font-size: 11px;
  color: var(--text-3);
}
.grid-history-list {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(160px, 182px);
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.grid-history-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 16px;
  background: rgba(255,255,255,0.78);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.grid-history-item:hover {
  border-color: rgba(33, 88, 255, 0.18);
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.grid-history-item.active {
  border-color: rgba(33, 88, 255, 0.26);
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.86));
  box-shadow: 0 14px 28px rgba(33, 88, 255, 0.12);
}
.grid-history-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(14, 19, 28, 0.05);
}
.grid-history-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.grid-history-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grid-history-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grid-history-meta {
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.45;
  word-break: break-word;
}

.latest-grid-strip {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,255,255,0.62));
}
.latest-grid-strip-thumb {
  width: 72px;
  height: 48px;
  padding: 0;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 10px;
  overflow: hidden;
  background: rgba(14, 19, 28, 0.06);
  cursor: zoom-in;
  box-shadow: none;
}
.latest-grid-strip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.latest-grid-strip-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.latest-grid-strip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.latest-grid-strip-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.latest-grid-strip-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--text-3);
}
.latest-grid-strip-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* Export */
.export-split { flex: 1; display: flex; min-height: 0; }
.export-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; }
.export-video { max-width: 720px; width: 100%; border-radius: var(--radius-lg); background: #000; }
.export-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; width: 100%; max-width: 720px; }
.export-list { width: 240px; flex-shrink: 0; border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
.export-list-head { padding: 11px 14px; font-size: 11px; font-weight: 700; color: var(--text-3); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.06em; }
.export-list-body { flex: 1; overflow-y: auto; padding: 6px; }
.exp-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius); }
.exp-row:hover { background: var(--bg-hover); }
.export-error { max-width: 520px; margin-top: 10px; padding: 9px 12px; border: 1px solid rgba(185, 28, 28, 0.18); border-radius: var(--radius); color: var(--error); background: rgba(254, 242, 242, 0.82); font-size: 12px; line-height: 1.5; text-align: center; }

/* Shared */
.dim { color: var(--text-3); }

@media (max-width: 1240px) {
  .studio-body {
    grid-template-columns: 1fr;
  }

  .studio-topbar {
    flex-direction: column;
    align-items: stretch;
  }

  .studio-topbar-side {
    justify-content: space-between;
  }

  .split-layout,
  .export-split {
    flex-direction: column;
  }

  .sidebar {
    max-height: 340px;
  }

  .shot-list,
  .export-list {
    width: 100%;
  }

  .detail-panel {
    min-height: 420px;
  }

  .field-grid-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .image-viewer-overlay {
    padding: 16px;
  }

  .image-viewer-dialog {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
  }

  .grid-tool {
    width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
  }

  .grid-preview-layout {
    grid-template-columns: 1fr;
  }

  .grid-preview-wrap,
  .grid-preview-img {
    max-height: 42vh;
  }

  .grid-assignment-pane {
    max-height: 42vh;
  }

  .grid-assign-columns {
    display: none;
  }

  .grid-assign-row {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}

@media (max-width: 860px) {
  .studio {
    padding: 12px;
    gap: 12px;
  }

  .studio-topbar-main {
    align-items: flex-start;
  }

  .studio-topbar-side,
  .studio-actions {
    flex-wrap: wrap;
  }

  .toolbar-right,
  .step-bubble,
  .export-bar {
    flex-wrap: wrap;
  }

  .extract-grid,
  .voice-grid,
  .asset-grid,
  .prod-grid {
    grid-template-columns: 1fr;
  }

  .voice-stage {
    grid-template-columns: 1fr;
  }

  .extract-stage {
    grid-template-columns: 1fr;
  }

  .extract-summary {
    position: static;
  }

  .voice-stage-panel {
    position: static;
    max-height: none;
    overflow: visible;
  }

  .frame-row {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-hero {
    grid-template-columns: 1fr;
  }

  .field-grid-2,
  .field-grid-4 {
    grid-template-columns: 1fr;
  }

  .frame-thumbs {
    width: 100%;
  }

  .frame-thumb {
    width: 100%;
  }

  .frame-generation-error {
    width: 100%;
  }

  .latest-grid-strip {
    grid-template-columns: 1fr;
  }

  .grid-history-list {
    grid-auto-columns: minmax(148px, 168px);
  }

  .latest-grid-strip-thumb {
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
  }

  .latest-grid-strip-actions {
    justify-content: flex-start;
  }
}
</style>
