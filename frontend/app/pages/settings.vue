<template>
  <div class="settings-layout">
    <aside class="settings-nav">
      <div class="nav-group">
        <div class="nav-group-label">基础</div>
        <button v-for="t in baseTabs" :key="t.id" :class="['nav-item', { active: tab === t.id }]" @click="tab = t.id">
          <component :is="t.icon" :size="14" />
          {{ t.label }}
        </button>
      </div>
      <div class="nav-advanced">
        <label class="advanced-toggle">
          <span>Agent 高级配置</span>
          <input type="checkbox" v-model="showAdvanced" />
          <span class="advanced-slider"></span>
        </label>
        <p class="advanced-note">仅展开 Agent 配置与 Skills。工作台功能和分镜字段保持默认可见。</p>
      </div>
      <div v-if="showAdvanced" class="nav-group">
        <div class="nav-group-label">高级</div>
        <button v-for="t in advancedTabs" :key="t.id" :class="['nav-item', { active: tab === t.id }]" @click="tab = t.id">
          <component :is="t.icon" :size="14" />
          {{ t.label }}
        </button>
      </div>
    </aside>

    <div class="settings-content">

      <!-- ===== AI 服务配置 ===== -->
      <div v-if="tab === 'ai'" class="settings-scroll">
        <div class="settings-head">
          <div class="settings-brand">
            <div class="settings-brand-mark">
              <img v-if="showBrandImage" :src="brandLogo" alt="Eggfans" class="settings-brand-logo" @error="showBrandImage = false" />
              <span v-else class="settings-brand-fallback">E</span>
            </div>
            <div class="settings-brand-copy">
              <div class="settings-brand-kicker">Eggfans Studio</div>
              <div class="settings-brand-name">Eggfans</div>
            </div>
          </div>
          <h2 class="settings-title">AI 服务配置</h2>
          <p class="settings-desc">先用推荐模板快速落配置，再按服务类型微调。工作台创建集时会锁定所选图片、视频和音频能力。</p>
        </div>
        <section class="setup-panel card">
          <div class="setup-panel-head">
            <div>
              <div class="setup-kicker">Quick Setup</div>
              <div class="setup-title">推荐配置</div>
              <div class="setup-desc">可一键写入 Eggfans 聚合站配置；Seedance 2.0 视频会保留火山官方接口。</div>
            </div>
            <button class="btn btn-primary" @click="openPresetDialog">
              <Sparkles :size="14" /> 一键配置
            </button>
            <button class="btn btn-ghost" @click="openPresetDialog">
              <Pencil :size="14" /> 编辑推荐
            </button>
          </div>
          <div class="preset-grid">
            <article v-for="preset in eggfansPresetCards" :key="`${preset.serviceType}-${preset.provider}-${preset.model}`" class="preset-card">
              <div class="preset-card-top">
                <span class="preset-service">{{ preset.label }}</span>
                <span class="tag tag-accent">{{ preset.provider }}</span>
              </div>
              <div class="preset-model mono">{{ preset.model }}</div>
              <div class="preset-base mono">{{ preset.baseUrl }}</div>
            </article>
          </div>
        </section>
        <section class="setup-panel card">
          <div class="setup-panel-head compact">
            <div>
              <div class="setup-title">快捷模板</div>
              <div class="setup-desc">选择服务类型后，直接用模板填充推荐的 `provider / base URL / model`。</div>
            </div>
          </div>
          <div class="template-row">
            <button
              v-for="st in serviceTypes"
              :key="st.type"
              class="template-type-chip"
              @click="startAddCfg(st.type)"
            >
              {{ st.label }}
            </button>
          </div>
        </section>
        <section class="setup-panel card">
          <div class="setup-panel-head compact">
            <div>
              <div class="setup-title">火山素材上传 Key</div>
              <div class="setup-desc">Seedance 2.0 官方视频会先把角色图、场景图、首尾帧上传到火山素材库，再用 @资产ID 作为参考。</div>
            </div>
            <span :class="['tag', assetUploadConfig?.has_api_key ? 'tag-success' : 'tag-error']">
              {{ assetUploadConfig?.has_api_key ? `已配置 ${assetUploadConfig.api_key_hint || ''}` : '未配置' }}
            </span>
          </div>
          <div class="asset-key-row">
            <label class="field asset-key-field">
              <span class="field-label">API Key</span>
              <input v-model="assetKeyDraft" class="input" type="password" placeholder="用于火山资产素材库上传的山河聚合 Key" />
            </label>
            <button class="btn" :disabled="assetKeyTesting || (!assetKeyDraft && !assetUploadConfig)" @click="testAssetUploadKey">
              <Loader2 v-if="assetKeyTesting" :size="12" class="animate-spin" />
              <span v-else>测试</span>
            </button>
            <button class="btn btn-primary" :disabled="assetKeySaving || !assetKeyDraft" @click="saveAssetUploadKey">
              <Loader2 v-if="assetKeySaving" :size="12" class="animate-spin" />
              <span v-else>保存素材 Key</span>
            </button>
          </div>
          <div v-if="assetKeyTestResult" class="test-result compact" :class="{ ok: assetKeyTestResult.reachable, bad: !assetKeyTestResult.reachable }">
            <div class="test-result-head">
              <span class="tag" :class="assetKeyTestResult.reachable ? 'tag-success' : 'tag-error'">{{ assetKeyTestResult.status || 'ERROR' }}</span>
              <span>{{ assetKeyTestResult.message }}</span>
            </div>
            <div class="mono test-result-url">{{ assetKeyTestResult.method }} {{ assetKeyTestResult.url }}</div>
          </div>
        </section>
        <section class="setup-panel card">
          <div class="setup-panel-head compact">
            <div>
              <div class="setup-title">Eggfans 备用图床 Key</div>
              <div class="setup-desc">Grok 等 Eggfans 视频参考图会优先尝试 Uguu；Uguu 上传失败后，会使用这个 Eggfans 图床继续上传公网参考图。</div>
            </div>
            <span :class="['tag', eggfansImageHostConfig?.has_api_key ? 'tag-success' : 'tag-error']">
              {{ eggfansImageHostConfig?.has_api_key ? `已配置 ${eggfansImageHostConfig.api_key_hint || ''}` : '未配置' }}
            </span>
          </div>
          <div class="asset-key-row">
            <label class="field asset-key-field">
              <span class="field-label">API Key</span>
              <input v-model="eggfansImageHostKeyDraft" class="input" type="password" placeholder="用于 Eggfans 备用图床的聚合站 Key" />
            </label>
            <button class="btn" :disabled="eggfansImageHostKeyTesting || (!eggfansImageHostKeyDraft && !eggfansImageHostConfig)" @click="testEggfansImageHostKey">
              <Loader2 v-if="eggfansImageHostKeyTesting" :size="12" class="animate-spin" />
              <span v-else>测试</span>
            </button>
            <button class="btn btn-primary" :disabled="eggfansImageHostKeySaving || !eggfansImageHostKeyDraft" @click="saveEggfansImageHostKey">
              <Loader2 v-if="eggfansImageHostKeySaving" :size="12" class="animate-spin" />
              <span v-else>保存图床 Key</span>
            </button>
          </div>
          <div v-if="eggfansImageHostKeyTestResult" class="test-result compact" :class="{ ok: eggfansImageHostKeyTestResult.reachable, bad: !eggfansImageHostKeyTestResult.reachable }">
            <div class="test-result-head">
              <span class="tag" :class="eggfansImageHostKeyTestResult.reachable ? 'tag-success' : 'tag-error'">{{ eggfansImageHostKeyTestResult.status || 'ERROR' }}</span>
              <span>{{ eggfansImageHostKeyTestResult.message }}</span>
            </div>
            <div class="mono test-result-url">{{ eggfansImageHostKeyTestResult.method }} {{ eggfansImageHostKeyTestResult.url }}</div>
          </div>
        </section>
        <div class="sections">
          <section v-for="st in serviceTypes" :key="st.type">
            <div class="section-head">
              <div>
                <span class="section-title">{{ st.label }}</span>
                <div class="section-subtitle">{{ serviceMeta[st.type].desc }}</div>
              </div>
              <span v-if="countActive(st.type)" class="tag tag-accent">{{ countActive(st.type) }} 已启用</span>
              <button class="btn btn-ghost btn-sm ml-auto" @click="startAddCfg(st.type)"><Plus :size="13" /> 添加</button>
            </div>
            <div class="config-list">
              <div v-for="c in byType(st.type)" :key="c.id" class="card config-row">
                <div class="config-info">
                  <div class="config-main">
                    <div class="config-line">
                      <span class="config-provider">{{ c.provider }}</span>
                      <span class="config-name">{{ c.name || `${c.provider}-${c.service_type}` }}</span>
                    </div>
                    <span class="config-model mono truncate">{{ fmtModel(c.model) }}</span>
                    <span class="config-base mono truncate">{{ c.base_url || '未设置 Base URL' }}</span>
                  </div>
                </div>
                <span :class="['tag', c.has_api_key ? 'tag-success' : 'tag-error']">{{ c.has_api_key ? `已配置 ${c.api_key_hint || ''}` : '无密钥' }}</span>
                <button class="btn btn-ghost btn-sm" @click="testExistingCfg(c)">测试</button>
                <label class="toggle"><input type="checkbox" :checked="c.is_active" @change="toggleCfg(c)"><span /></label>
                <button class="btn btn-ghost btn-icon" @click="startEditCfg(c)"><Pencil :size="13" /></button>
                <button class="btn btn-ghost btn-icon" @click="delCfg(c.id)"><Trash2 :size="13" /></button>
              </div>
              <p v-if="!byType(st.type).length" class="config-empty">暂无配置</p>
            </div>
          </section>
        </div>
      </div>

      <!-- ===== Agent 配置 ===== -->
      <div v-else-if="tab === 'agents'" class="settings-scroll">
        <div class="settings-head">
          <div class="settings-brand">
            <div class="settings-brand-mark">
              <img v-if="showBrandImage" :src="brandLogo" alt="Eggfans" class="settings-brand-logo" @error="showBrandImage = false" />
              <span v-else class="settings-brand-fallback">E</span>
            </div>
            <div class="settings-brand-copy">
              <div class="settings-brand-kicker">Eggfans Studio</div>
              <div class="settings-brand-name">Eggfans</div>
            </div>
          </div>
          <h2 class="settings-title">Agent 配置</h2>
          <p class="settings-desc">高级区只保留 Agent 运行配置。这里可以调整模型、提示词和参数，保存后立即生效。</p>
        </div>
        <div class="agent-list">
          <div v-for="a in agentDefs" :key="a.type" class="card agent-card">
            <div class="agent-card-head" @click="toggleAgentEdit(a.type)">
              <div class="agent-type-badge">{{ a.icon }}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:14px">{{ a.label }}</div>
                <div class="dim" style="font-size:12px">{{ a.type }}</div>
              </div>
              <span v-if="getAgentCfg(a.type)" class="tag tag-success">已配置</span>
              <span v-else class="tag">默认</span>
              <ChevronDown :size="14" :style="{ transform: editingAgent === a.type ? 'rotate(180deg)' : '', transition: '0.2s' }" />
            </div>
            <div v-if="editingAgent === a.type" class="agent-card-body">
              <label class="field">
                <span class="field-label">模型 <span class="dim">(留空使用 AI 服务默认)</span></span>
                <BaseSelect v-model="agentForm.model" :options="textModelSelectOptions" placeholder="— 使用 AI 服务默认 —" searchable />
                <span class="field-hint">留空时，剧本改写、角色场景提取、分镜拆解等 Agent 会跟随“AI 服务配置”里优先级最高的启用文本模型。</span>
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">Temperature</span>
                  <input v-model.number="agentForm.temperature" class="input" type="number" min="0" max="2" step="0.1" />
                </label>
                <label class="field">
                  <span class="field-label">Max Tokens</span>
                  <input v-model.number="agentForm.max_tokens" class="input" type="number" min="100" max="32000" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">System Prompt</span>
                <textarea v-model="agentForm.system_prompt" class="textarea" rows="12" placeholder="Agent 系统提示词..." />
              </label>
              <div class="agent-card-foot">
                <button class="btn btn-ghost btn-sm" @click="resetAgentPrompt(a.type)">恢复默认</button>
                <span v-if="agentSaved === a.type" class="tag tag-success" style="margin-left:8px">
                  <Check :size="10" /> 已保存
                </span>
                <button class="btn btn-primary btn-sm ml-auto" :disabled="agentSaving" @click="saveAgentCfg(a.type)">
                  <Loader2 v-if="agentSaving" :size="12" class="animate-spin" />
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== Skills 编辑 ===== -->
      <div v-else-if="tab === 'skills'" class="skills-layout">
        <!-- Agent 左侧列表 -->
        <aside class="skills-agent-list">
          <div class="skills-agent-title">Agent 列表</div>
          <button
            v-for="a in agentDefs"
            :key="a.type"
            :class="['skills-agent-item', { active: selectedAgent === a.type }]"
            @click="selectAgent(a.type)"
          >
            <span class="agent-type-badge">{{ a.icon }}</span>
            <span class="skills-agent-label">{{ a.label }}</span>
            <span v-if="agentSkillCount(a.type) > 0" class="skill-count-badge">{{ agentSkillCount(a.type) }}</span>
          </button>
        </aside>

        <!-- Skill 管理右侧主区域 -->
        <div class="settings-scroll skills-main">
          <div class="settings-head">
            <div class="settings-brand">
              <div class="settings-brand-mark">
                <img v-if="showBrandImage" :src="brandLogo" alt="Eggfans" class="settings-brand-logo" @error="showBrandImage = false" />
                <span v-else class="settings-brand-fallback">E</span>
              </div>
              <div class="settings-brand-copy">
                <div class="settings-brand-kicker">Eggfans Studio</div>
                <div class="settings-brand-name">Eggfans</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="agent-type-badge" style="width:32px;height:32px;font-size:16px">{{ selectedAgentIcon }}</span>
              <div>
                <h2 class="settings-title" style="margin:0">{{ selectedAgentLabel }}</h2>
                <div class="dim" style="font-size:12px">{{ selectedAgentType }} — Skills</div>
              </div>
            </div>
            <p class="settings-desc" style="margin-top:10px">Skills 仅作为 Agent 的高级提示词层使用，不影响工作台常规功能入口。</p>
            <button class="btn btn-primary btn-sm" @click="startAddSkill">
              <Plus :size="13" /> 新增 Skill
            </button>
          </div>

          <!-- 无 skill 提示 -->
          <div v-if="!currentSkills.length" class="step-empty" style="padding:48px 24px">
            <div class="empty-visual">
              <FileText :size="28" />
            </div>
            <div class="empty-title">暂无 Skill</div>
            <div class="empty-desc">点击右上角「新增 Skill」创建第一个提示词文件</div>
          </div>

          <!-- Skill 列表 -->
          <div class="skill-list" v-else>
            <div v-for="s in currentSkills" :key="s.id" class="card skill-card">
              <div class="skill-card-head" @click="toggleSkillEdit(s.id)">
                <FileText :size="14" style="color:var(--accent);flex-shrink:0" />
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;font-size:13px">{{ s.name }}</div>
                  <div class="dim" style="font-size:11px">{{ s.description }}</div>
                </div>
                <button class="btn btn-ghost btn-icon" style="margin-right:4px" @click.stop="deleteSkill(s.id)">
                  <Trash2 :size="13" />
                </button>
                <ChevronDown :size="14" :style="{ transform: editingSkill === s.id ? 'rotate(180deg)' : '', transition: '0.2s' }" />
              </div>
              <div v-if="editingSkill === s.id" class="skill-card-body">
                <textarea
                  v-model="skillContent"
                  class="textarea mono"
                  rows="20"
                  style="font-size:12px;line-height:1.6"
                  placeholder="编写 SKILL.md 内容..."
                />
                <div class="skill-card-foot">
                  <span class="dim" style="font-size:11px">skills/{{ selectedAgentType }}/{{ s.id }}/SKILL.md</span>
                  <span v-if="skillSaved === s.id" class="tag tag-success" style="margin-left:8px">
                    <Check :size="10" /> 已保存
                  </span>
                  <button class="btn btn-primary btn-sm ml-auto" :disabled="skillSaving" @click="saveSkill(s.id)">
                    <Loader2 v-if="skillSaving" :size="12" class="animate-spin" />
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- AI Config Dialog -->
    <div v-if="cfgDialog" class="overlay" @click.self="cfgDialog = false">
      <form class="modal card config-modal" @submit.prevent="saveCfg">
        <div class="config-modal-head">
          <div>
            <div class="setup-kicker">{{ cfgEditId ? 'Edit Config' : 'New Config' }}</div>
            <h2 class="modal-title">{{ cfgEditId ? '编辑服务配置' : `添加${serviceMeta[cfgForm.service_type].label}服务` }}</h2>
            <div class="modal-note">推荐先选择模板，系统会自动填入更合理的 `Base URL` 与默认模型。</div>
          </div>
          <span class="tag tag-accent">{{ serviceMeta[cfgForm.service_type].label }}</span>
        </div>
        <div class="preset-picker">
          <button
            v-for="preset in presetsByType(cfgForm.service_type)"
            :key="`${cfgForm.service_type}-${preset.provider}`"
            type="button"
            class="preset-pill"
            @click="applyProviderPreset(cfgForm.service_type, preset.provider)"
          >
            {{ preset.label }}
          </button>
        </div>
        <label class="field">
          <span class="field-label">配置名称</span>
          <input v-model="cfgForm.name" class="input" placeholder="如 Eggfans 默认图像服务" />
        </label>
        <label class="field"><span class="field-label">服务商</span>
          <BaseSelect v-model="cfgForm.provider" :options="providerSelectOptions" placeholder="选择服务商" searchable @update:model-value="onProviderChanged" />
        </label>
        <label class="field">
          <span class="field-label">优先级</span>
          <input v-model.number="cfgForm.priority" class="input" type="number" min="0" max="999" />
          <span class="field-hint">数值越高越优先。工作台默认会优先使用同类型里优先级最高的启用配置。</span>
        </label>
        <label class="field">
          <span class="field-label">API Key</span>
          <input v-model="cfgForm.api_key" class="input" type="password" :placeholder="cfgEditId ? '留空则保留现有密钥' : 'sk-...'" />
        </label>
        <label class="field"><span class="field-label">Base URL</span><input v-model="cfgForm.base_url" class="input" placeholder="https://..." /></label>
        <div class="endpoint-hint">
          <span class="dim">实际端点前缀：</span>
          <span class="mono">{{ endpointHint }}</span>
        </div>
        <label class="field">
          <span class="field-label">模型</span>
          <BaseSelect
            v-if="cfgForm.provider === 'eggfans'"
            :model-value="cfgForm.modelStr"
            :options="eggfansModelOptions"
            :placeholder="eggfansModelsLoading ? '正在加载 Eggfans 模型' : '选择 Eggfans 模型'"
            searchable
            @update:model-value="applyEggfansModel"
          />
          <BaseSelect
            v-else-if="cfgForm.provider === 'mijing'"
            :model-value="cfgForm.modelStr"
            :options="mijingModelOptions"
            :placeholder="mijingModelsLoading ? '正在加载谜镜模型' : '选择谜镜模型'"
            searchable
            @update:model-value="applyMijingModel"
          />
          <input v-else v-model="cfgForm.modelStr" class="input" placeholder="model-name" />
          <span v-if="cfgForm.provider === 'eggfans'" class="field-hint">模型来自 eggfans.com/api/pricing_new，并按当前服务类型过滤。</span>
          <span v-if="cfgForm.provider === 'mijing'" class="field-hint">模型来自谜镜 /v1/aimodels，并按当前服务类型过滤。</span>
          <span v-if="cfgForm.provider === 'grok_openai'" class="field-hint">OpenAI 兼容视频通道，默认使用 grok-imagine-video；参考图走公网 URL 或 base64，不上传火山素材库。</span>
        </label>
        <div v-if="cfgForm.provider === 'eggfans' && cfgEggfansMeta" class="eggfans-model-meta">
          <div>
            <span class="dim">调用族系</span>
            <span class="tag tag-accent">{{ cfgEggfansMeta.routeFamily || '未识别' }}</span>
          </div>
          <div>
            <span class="dim">生成端点</span>
            <span class="mono">{{ cfgForm.endpoint || '—' }}</span>
          </div>
          <div v-if="cfgForm.query_endpoint">
            <span class="dim">查询端点</span>
            <span class="mono">{{ cfgForm.query_endpoint }}</span>
          </div>
          <div v-if="cfgEggfansMeta.transmissionParameters">
            <span class="dim">传输参数</span>
            <span class="mono">{{ eggfansParameterHint }}</span>
          </div>
        </div>
        <div v-if="cfgForm.provider === 'eggfans' && cfgForm.service_type === 'video'" class="provider-note">
          Seedance 2.0 视频模型保持火山官方 provider=volcengine，不走 Eggfans 视频适配器。
        </div>
        <div v-if="cfgForm.provider === 'mijing' && cfgMijingMeta" class="eggfans-model-meta">
          <div>
            <span class="dim">显示名称</span>
            <span class="tag tag-accent">{{ cfgMijingMeta.displayName || cfgMijingMeta.modelName }}</span>
          </div>
          <div>
            <span class="dim">生成端点</span>
            <span class="mono">{{ cfgForm.endpoint || '—' }}</span>
          </div>
          <div v-if="cfgForm.query_endpoint">
            <span class="dim">查询端点</span>
            <span class="mono">{{ cfgForm.query_endpoint }}</span>
          </div>
          <div v-if="cfgMijingMeta.transmissionParameters">
            <span class="dim">传输参数</span>
            <span class="mono">{{ mijingParameterHint }}</span>
          </div>
        </div>
        <div v-if="cfgForm.provider === 'mijing' && cfgForm.service_type === 'video'" class="provider-note">
          谜镜 seedance2.0创作版走谜镜网关顶层字段：reference_image_urls、duration、ratio、watermark=false、generate_audio=true、resolution=720p；官方火山 Seedance 2.0 配置仍使用 volcengine。
        </div>
        <div v-if="cfgForm.provider === 'grok_openai' && cfgForm.service_type === 'video'" class="provider-note">
          Grok Imagine 使用 OpenAI 兼容视频端点：/v1/videos/generations 创建、/v1/videos/{id} 查询；请求字段为 model、prompt、image/reference_images、duration、aspect_ratio、resolution，不使用火山资产 URI。
        </div>
        <div v-if="cfgTestResult" class="test-result" :class="{ ok: cfgTestResult.reachable, bad: !cfgTestResult.reachable }">
          <div class="test-result-head">
            <span class="tag" :class="cfgTestResult.reachable ? 'tag-success' : 'tag-error'">{{ cfgTestResult.status || 'ERROR' }}</span>
            <span>{{ cfgTestResult.message }}</span>
          </div>
          <div class="mono test-result-url">{{ cfgTestResult.method }} {{ cfgTestResult.url }}</div>
          <div v-if="cfgTestResult.request_preview" class="mono test-result-preview">请求体：{{ cfgTestResult.request_preview }}</div>
          <div v-if="cfgTestResult.response_preview" class="mono test-result-preview">{{ cfgTestResult.response_preview }}</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="cfgTesting" @click="testDraftCfg">
            <Loader2 v-if="cfgTesting" :size="12" class="animate-spin" />
            <span v-else>测试配置</span>
          </button>
          <button type="button" class="btn" @click="cfgDialog = false">取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      </form>
    </div>

    <!-- Eggfans Preset Dialog -->
    <div v-if="presetDialog" class="overlay" @click.self="presetDialog = false">
      <form class="modal card config-modal" @submit.prevent="applyEggfansPreset">
        <div class="config-modal-head">
          <div>
            <div class="setup-kicker">Provider Preset</div>
            <h2 class="modal-title">Eggfans 聚合站配置</h2>
            <div class="modal-note">写入 Eggfans 文本、图片、视频、音频配置，并额外创建 Seedance 2.0 官方火山视频配置。</div>
          </div>
          <span class="tag tag-success">推荐</span>
        </div>
        <div class="preset-form-grid">
          <label class="field">
            <span class="field-label">Eggfans API Key <span class="dim">(文本 / 图片 / 非 Seedance 视频 / 音频)</span></span>
            <input v-model="presetForm.eggfansApiKey" class="input" type="password" placeholder="用于 api.eggfans.com 聚合站服务" />
            <span class="field-hint">模型目录来自 <a href="https://eggfans.com/api/pricing_new" target="_blank" rel="noopener">pricing_new</a></span>
          </label>
          <label class="field">
            <span class="field-label">火山 Seedance 2.0 API Key <span class="dim">(可留空，后续补填)</span></span>
            <input v-model="presetForm.seedanceApiKey" class="input" type="password" placeholder="用于 ark.cn-beijing.volces.com 官方接口" />
            <span class="field-hint">不要填写 Eggfans Key。留空也会创建官方 Seedance 配置，后续在 API 配置里补火山 Ark API Key 即可调用。</span>
          </label>
        </div>
        <div class="preset-grid compact">
          <article v-for="preset in eggfansPresetCards" :key="`${preset.serviceType}-${preset.provider}-${preset.model}`" class="preset-card">
            <div class="preset-card-top">
              <span class="preset-service">{{ preset.label }}</span>
              <span class="tag tag-accent">{{ preset.provider }}</span>
            </div>
            <div class="preset-model mono">{{ preset.model }}</div>
            <div class="preset-base mono">{{ preset.baseUrl }}</div>
          </article>
        </div>
        <div class="preset-editor">
          <div class="preset-editor-head">
            <div class="setup-title">偏好模型</div>
            <button type="button" class="btn btn-ghost btn-sm" @click="resetPresetPreferences">恢复推荐</button>
          </div>
          <div class="preset-model-grid">
            <label v-for="item in editableEggfansPresetCards" :key="item.serviceType" class="field">
              <span class="field-label">{{ item.label }}</span>
              <BaseSelect
                v-model="presetForm.models[item.serviceType]"
                :options="presetModelOptions(item.serviceType)"
                :placeholder="eggfansModelsLoading ? '正在加载模型' : '选择偏好模型'"
                searchable
              />
              <span class="field-hint">{{ presetModelHint(item.serviceType) }}</span>
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" @click="presetDialog = false">取消</button>
          <button type="submit" class="btn btn-primary">创建 Eggfans 配置</button>
        </div>
      </form>
    </div>

    <!-- Add Skill Dialog -->
    <div v-if="addSkillDialog" class="overlay" @click.self="addSkillDialog = false">
      <form class="modal card" @submit.prevent="confirmAddSkill">
        <h2 class="modal-title">新增 Skill — {{ selectedAgentLabel }}</h2>
        <label class="field">
          <span class="field-label">Skill 目录名 <span class="dim">(英文，唯一)</span></span>
          <input v-model="newSkillForm.id" class="input" placeholder="如 custom-extraction" />
        </label>
        <label class="field">
          <span class="field-label">名称</span>
          <input v-model="newSkillForm.name" class="input" placeholder="如 自定义提取规则" />
        </label>
        <label class="field">
          <span class="field-label">描述</span>
          <input v-model="newSkillForm.description" class="input" placeholder="简短描述此 Skill 的用途" />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn" @click="addSkillDialog = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="!newSkillForm.id">创建</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { Plus, Pencil, Trash2, FileText, ChevronDown, Check, Loader2, Bot, Cpu, Sparkles } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import { toast } from 'vue-sonner'
import { aiConfigAPI, agentConfigAPI, skillsAPI, eggfansModelAPI, mijingModelAPI, preferenceAPI } from '~/composables/useApi'
import brandLogo from '~/assets/eggfans-logo.png'

const showBrandImage = ref(true)
const tab = ref('ai')
const showAdvanced = ref(false)
const baseTabs = [
  { id: 'ai', label: 'AI 服务', icon: Cpu },
]
const advancedTabs = [
  { id: 'agents', label: 'Agent 配置', icon: Bot },
  { id: 'skills', label: 'Skills', icon: FileText },
]
watch(showAdvanced, (v) => {
  if (!v && tab.value !== 'ai') tab.value = 'ai'
})

// ===== AI Service Configs =====
const cfgs = ref([])
const cfgDialog = ref(false)
const cfgEditId = ref(null)
const presetDialog = ref(false)
const cfgTesting = ref(false)
const cfgTestResult = ref(null)
const assetKeyDraft = ref('')
const assetKeySaving = ref(false)
const assetKeyTesting = ref(false)
const assetKeyTestResult = ref(null)
const eggfansImageHostKeyDraft = ref('')
const eggfansImageHostKeySaving = ref(false)
const eggfansImageHostKeyTesting = ref(false)
const eggfansImageHostKeyTestResult = ref(null)
const cfgForm = reactive({
  name: '',
  provider: '',
  api_key: '',
  base_url: '',
  modelStr: '',
  service_type: 'text',
  priority: 0,
  endpoint: '',
  query_endpoint: '',
  settings: null,
})
const presetForm = reactive({
  eggfansApiKey: '',
  seedanceApiKey: '',
  models: {
    text: 'gpt-5.5',
    image: 'gpt-image-2-c',
    video: 'grok-video-3-10s',
    audio: 'speech-2.8-hd',
  },
})
const serviceTypes = [{ type: 'text', label: '文本' }, { type: 'image', label: '图片' }, { type: 'video', label: '视频' }, { type: 'audio', label: '音频' }]
const providers = ['ali', 'chatfire', 'eggfans', 'gemini', 'grok_openai', 'mijing', 'minimax', 'openai', 'openrouter', 'vidu', 'volcengine']
const providerLabels = {
  ali: '阿里百炼',
  chatfire: 'ChatFire',
  eggfans: 'Eggfans 聚合站',
  gemini: 'Gemini',
  grok_openai: 'Grok Imagine · OpenAI 兼容',
  mijing: '谜镜',
  minimax: 'MiniMax',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  vidu: 'Vidu',
  volcengine: '火山方舟官方',
}
const providerSelectOptions = computed(() => providers.map(p => ({ label: providerLabels[p] || p, value: p })))
const serviceMeta = {
  text: { label: '文本', desc: '剧本改写、角色场景提取、分镜拆解等 Agent 文本能力' },
  image: { label: '图片', desc: '角色图、场景图、镜头图与首尾帧等静态图像生成' },
  video: { label: '视频', desc: '镜头视频生成，支持单图、多图和首尾帧模式' },
  audio: { label: '音频', desc: '角色试听、旁白与对白语音生成' },
  asset: { label: '素材上传', desc: '火山素材库上传通道' },
}
const providerPresets = {
  text: {
    eggfans: { label: 'Eggfans 推荐', baseUrl: 'https://api.eggfans.com', models: ['gpt-5.5'] },
    mijing: { label: '谜镜文本', baseUrl: 'https://api.mjing.cc', models: ['豆包2.0-pro'] },
    chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-preview'] },
    openrouter: { label: 'OpenRouter 推荐', baseUrl: 'https://openrouter.ai/api', models: ['google/gemini-3-flash-preview'] },
    openai: { label: 'OpenAI 推荐', baseUrl: 'https://api.openai.com', models: ['gpt-4.1-mini'] },
  },
  image: {
    eggfans: { label: 'Eggfans 推荐', baseUrl: 'https://api.eggfans.com', models: ['gpt-image-2-c'] },
    mijing: { label: '谜镜图片', baseUrl: 'https://api.mjing.cc', models: ['Seedream5.0'] },
    chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['doubao-seedream-4-5-251128'] },
    gemini: { label: 'Gemini 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-image-preview'] },
    volcengine: { label: '火山推荐', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedream-4-0-250828'] },
  },
  video: {
    volcengine: { label: 'Seedance 2.0 官方', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedance-2-0-260128'] },
    mijing: { label: '谜镜视频', baseUrl: 'https://api.magine.work', models: ['seedance2.0创作版'] },
    grok_openai: {
      label: 'Grok Imagine OpenAI',
      baseUrl: 'https://api.aigcly.top',
      models: ['grok-imagine-video'],
      endpoint: '/v1/videos/generations',
      query_endpoint: '/v1/videos/{id}',
      settings: {
        grokOpenai: {
          defaults: { resolution: '720p' },
        },
      },
    },
    eggfans: { label: 'Eggfans 视频', baseUrl: 'https://api.eggfans.com', models: ['grok-video-3-10s'] },
    vidu: { label: 'Vidu 推荐', baseUrl: 'https://api.vidu.com', models: ['viduq3-turbo'] },
    ali: { label: '阿里推荐', baseUrl: 'https://dashscope.aliyuncs.com', models: ['wan2.6-i2v-flash'] },
  },
  audio: {
    eggfans: { label: 'Eggfans 音频', baseUrl: 'https://api.eggfans.com', models: ['speech-2.8-hd'] },
    minimax: { label: 'MiniMax 音频', baseUrl: 'https://api.chatfire.site/minimax', models: ['speech-2.8-hd'] },
  },
}
const presetDefaults = {
  text: 'gpt-5.5',
  image: 'gpt-image-2-c',
  video: 'grok-video-3-10s',
  audio: 'speech-2.8-hd',
}
const presetStorageKey = 'eggfans:preset-model-preferences'
const modelPreferenceKey = 'model-preferences-preset'
let presetPreferencesHydrated = false
let presetPreferenceSave = Promise.resolve()
function presetPriority(serviceType, provider) {
  if (serviceType === 'video' && provider === 'volcengine') return 108
  if (serviceType === 'video' && provider === 'eggfans') return 98
  if (serviceType === 'text') return 100
  if (serviceType === 'image') return 99
  if (serviceType === 'audio') return 97
  return 0
}
const editableEggfansPresetCards = [
  { serviceType: 'text', label: '文本', provider: 'eggfans', baseUrl: 'https://api.eggfans.com', priority: presetPriority('text', 'eggfans') },
  { serviceType: 'image', label: '图片', provider: 'eggfans', baseUrl: 'https://api.eggfans.com', priority: presetPriority('image', 'eggfans') },
  { serviceType: 'video', label: '视频', provider: 'eggfans', baseUrl: 'https://api.eggfans.com', priority: presetPriority('video', 'eggfans') },
  { serviceType: 'audio', label: '音频', provider: 'eggfans', baseUrl: 'https://api.eggfans.com', priority: presetPriority('audio', 'eggfans') },
]
const eggfansPresetCards = computed(() => [
  ...editableEggfansPresetCards.map(preset => ({
    ...preset,
    model: presetForm.models[preset.serviceType] || presetDefaults[preset.serviceType],
  })),
  { serviceType: 'video', label: 'Grok Imagine OpenAI', provider: 'grok_openai', baseUrl: 'https://api.aigcly.top', model: 'grok-imagine-video', priority: 96 },
  { serviceType: 'seedance', label: 'Seedance 2.0 官方', provider: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com', model: 'doubao-seedance-2-0-260128', priority: presetPriority('video', 'volcengine') },
])
const endpointPrefixes = {
  chatfire: '/v1',
  eggfans: '/v1',
  mijing: '/v1',
  grok_openai: '/v1',
  openai: '/v1',
  openrouter: '/v1',
  minimax: '/v1',
  gemini: '/v1beta',
  volcengine: '/api/v3',
  ali: '/api/v1',
  vidu: '/ent/v2',
  volcengine_asset: '/v1/assets',
  eggfans_image_host: '',
}
const assetUploadConfig = computed(() => cfgs.value.find(c => c.service_type === 'asset' && c.provider === 'volcengine_asset'))
const eggfansImageHostConfig = computed(() => cfgs.value.find(c => c.service_type === 'image_host' && c.provider === 'eggfans_image_host'))

const endpointHint = computed(() => {
  const provider = cfgForm.provider
  const base = cfgForm.base_url || 'https://...'
  if ((provider === 'eggfans' || provider === 'mijing' || provider === 'grok_openai') && cfgForm.endpoint) return `${base.replace(/\/+$/, '')}${cfgForm.endpoint}`
  const prefix = endpointPrefixes[provider] || ''
  if (!provider) return '选择服务商后显示推荐端点前缀'
  return `${base}${prefix}`
})

function byType(t) { return cfgs.value.filter(c => c.service_type === t) }
function countActive(t) { return byType(t).filter(c => c.is_active).length }
function fmtModel(m) { return Array.isArray(m) ? m.join(', ') : m || '—' }
function presetsByType(type) {
  const group = providerPresets[type] || {}
  return Object.entries(group).map(([provider, preset]) => ({ provider, ...preset }))
}
const eggfansModels = ref({})
const eggfansModelsLoading = ref(false)
const mijingModels = ref({})
const mijingModelsLoading = ref(false)
const cfgEggfansMeta = computed(() => cfgForm.settings?.eggfans || null)
const cfgMijingMeta = computed(() => cfgForm.settings?.mijing || null)
const eggfansParameterHint = computed(() => {
  const params = cfgEggfansMeta.value?.transmissionParameters
  if (!params) return '—'
  const required = (params.requiredFields || []).join(', ')
  const optional = (params.optionalFields || []).join(', ')
  return `${params.requestShape}: 必填 ${required || '—'}；可选 ${optional || '—'}`
})
const eggfansModelOptions = computed(() => {
  const rows = eggfansModels.value[cfgForm.service_type] || []
  return rows.map(m => ({
    label: `${m.name} · ${(m.endpointTypes || []).join('/')}${m.routeFamily ? ` · ${m.routeFamily}` : ''}`,
    value: m.name,
  }))
})
const mijingParameterHint = computed(() => {
  const params = cfgMijingMeta.value?.transmissionParameters
  if (!params) return '—'
  const required = (params.requiredFields || []).join(', ')
  const optional = (params.optionalFields || []).join(', ')
  return `${params.requestShape}: 必填 ${required || '—'}；可选 ${optional || '—'}`
})
const mijingModelOptions = computed(() => {
  const rows = mijingModels.value[cfgForm.service_type] || []
  return rows.map(m => ({
    label: `${m.displayName || m.name} · ${m.name} · ${m.serviceType}`,
    value: m.name,
  }))
})

function presetModelOptions(type) {
  const rows = eggfansModels.value[type] || []
  return rows.map(m => ({
    label: `${m.name} · ${(m.endpointTypes || []).join('/')}${m.routeFamily ? ` · ${m.routeFamily}` : ''}`,
    value: m.name,
  }))
}

function presetModelHint(type) {
  const model = getEggfansModel(type, presetForm.models[type])
  if (!model) return '将使用 Eggfans 聚合站推荐模型'
  if (model.routeFamily) return `${model.routeFamily} · ${model.endpointPath || '/v1'}`
  return (model.endpointTypes || []).join(' / ') || 'Eggfans 聚合站模型'
}

async function loadEggfansModels(type) {
  if (eggfansModels.value[type]) return
  eggfansModelsLoading.value = true
  try {
    const result = await eggfansModelAPI.list(type)
    eggfansModels.value = { ...eggfansModels.value, [type]: result.models || [] }
  } catch (e) {
    toast.error(`Eggfans 模型加载失败：${e.message}`)
  } finally {
    eggfansModelsLoading.value = false
  }
}

async function loadMijingModels(type) {
  if (mijingModels.value[type]) return
  mijingModelsLoading.value = true
  try {
    const result = await mijingModelAPI.list(type, cfgForm.base_url || 'https://api.mjing.cc', cfgEditId.value || undefined)
    mijingModels.value = { ...mijingModels.value, [type]: result.models || [] }
  } catch (e) {
    toast.error(`谜镜模型加载失败：${e.message}`)
  } finally {
    mijingModelsLoading.value = false
  }
}

async function loadPresetModels() {
  await Promise.all(['text', 'image', 'video', 'audio'].map(type => loadEggfansModels(type)))
}

function getEggfansModel(type, name) {
  const rows = eggfansModels.value[type] || []
  return rows.find(m => m.name === name)
}

function getMijingModel(type, name) {
  const rows = mijingModels.value[type] || []
  return rows.find(m => m.name === name)
}

function clearProviderMetadata() {
  cfgForm.endpoint = ''
  cfgForm.query_endpoint = ''
  cfgForm.settings = null
}

function applyGrokOpenAIModel(value) {
  cfgForm.modelStr = value || ''
  if (cfgForm.provider !== 'grok_openai') {
    clearProviderMetadata()
    return
  }
  cfgForm.endpoint = cfgForm.endpoint || '/v1/videos/generations'
  cfgForm.query_endpoint = cfgForm.query_endpoint || '/v1/videos/{id}'
  cfgForm.settings = cfgForm.settings?.grokOpenai
    ? cfgForm.settings
    : { grokOpenai: { defaults: { resolution: '720p' } } }
}

function applyEggfansModel(value) {
  cfgForm.modelStr = value || ''
  if (cfgForm.provider !== 'eggfans') {
    clearProviderMetadata()
    return
  }
  const model = getEggfansModel(cfgForm.service_type, cfgForm.modelStr)
  if (!model) {
    clearProviderMetadata()
    return
  }
  cfgForm.endpoint = model.endpointPath || ''
  cfgForm.query_endpoint = model.queryEndpointPath || ''
  cfgForm.settings = {
    eggfans: {
      modelName: model.name,
      serviceType: model.serviceType,
      modelType: model.modelType,
      tags: model.tags || [],
      endpointTypes: model.endpointTypes || [],
      endpoints: model.endpoints || [],
      routeFamily: model.routeFamily,
      primaryEndpointType: model.primaryEndpointType,
      endpointMethod: model.endpointMethod,
      queryEndpointMethod: model.queryEndpointMethod,
      transmissionParameters: model.transmissionParameters,
      price: model.price,
      quotaType: model.quotaType,
      vendorId: model.vendorId,
    },
  }
}

function applyMijingModel(value) {
  cfgForm.modelStr = value || ''
  if (cfgForm.provider !== 'mijing') {
    clearProviderMetadata()
    return
  }
  const model = getMijingModel(cfgForm.service_type, cfgForm.modelStr)
  if (!model) {
    clearProviderMetadata()
    return
  }
  cfgForm.endpoint = model.endpointPath || ''
  cfgForm.query_endpoint = model.queryEndpointPath || ''
  cfgForm.settings = {
    mijing: {
      modelName: model.name,
      displayName: model.displayName,
      serviceType: model.serviceType,
      modelType: model.modelType,
      endpointMethod: model.endpointMethod,
      queryEndpointMethod: model.queryEndpointMethod,
      extraJson: model.extraJson,
      transmissionParameters: model.transmissionParameters,
      defaults: model.serviceType === 'video'
        ? {
          watermark: false,
          generate_audio: true,
          resolution: '720p',
        }
        : model.serviceType === 'image' && /^gpt-image-2(?:-all|-c)?$/i.test(String(model.name || '').trim())
          ? {
            size: '1K',
            quality: 'high',
          }
        : undefined,
    },
  }
}

async function applyEggfansModelAfterLoad(type, modelName) {
  await loadEggfansModels(type)
  if (cfgForm.provider === 'eggfans' && cfgForm.service_type === type && cfgForm.modelStr === modelName) {
    applyEggfansModel(modelName)
  }
}

async function applyMijingModelAfterLoad(type, modelName) {
  await loadMijingModels(type)
  if (cfgForm.provider === 'mijing' && cfgForm.service_type === type && cfgForm.modelStr === modelName) {
    applyMijingModel(modelName)
  }
}

function applyProviderPreset(type, provider) {
  const preset = providerPresets[type]?.[provider]
  if (!preset) return
  cfgForm.provider = provider
  cfgForm.base_url = preset.baseUrl
  cfgForm.modelStr = preset.models.join(', ')
  cfgForm.name = `${preset.label}-${serviceMeta[type].label}`
  clearProviderMetadata()
  if (provider === 'eggfans') applyEggfansModelAfterLoad(type, preset.models[0])
  if (provider === 'mijing') applyMijingModelAfterLoad(type, preset.models[0])
  if (provider === 'grok_openai') {
    cfgForm.endpoint = preset.endpoint || '/v1/videos/generations'
    cfgForm.query_endpoint = preset.query_endpoint || '/v1/videos/{id}'
    cfgForm.settings = preset.settings || { grokOpenai: { defaults: { resolution: '720p' } } }
  }
}
function onProviderChanged(provider) {
  clearProviderMetadata()
  if (provider === 'eggfans') applyEggfansModelAfterLoad(cfgForm.service_type, cfgForm.modelStr)
  if (provider === 'mijing') applyMijingModelAfterLoad(cfgForm.service_type, cfgForm.modelStr)
  if (provider === 'grok_openai') applyGrokOpenAIModel(cfgForm.modelStr || 'grok-imagine-video')
}

function openPresetDialog() {
  presetDialog.value = true
  loadPresetModels()
}

function resetPresetPreferences() {
  Object.assign(presetForm.models, presetDefaults)
}

async function loadPresetPreferences() {
  let saved = null
  try {
    const stored = await preferenceAPI.get(modelPreferenceKey)
    saved = stored?.presetModels || null
  } catch (error) {
    console.warn('Failed to load saved model preferences', error)
  }

  // Migrate the existing browser-only preference once when the backend has no value.
  if (!saved && typeof window !== 'undefined') {
    try { saved = JSON.parse(window.localStorage.getItem(presetStorageKey) || '{}') } catch {}
  }

  if (saved && typeof saved === 'object') {
    for (const type of Object.keys(presetDefaults)) {
      if (typeof saved[type] === 'string' && saved[type].trim()) presetForm.models[type] = saved[type]
    }
  }
  presetPreferencesHydrated = true
  savePresetPreferences()
}

function savePresetPreferences() {
  const value = { presetModels: { ...presetForm.models } }
  presetPreferenceSave = presetPreferenceSave
    .catch(() => undefined)
    .then(() => preferenceAPI.set(modelPreferenceKey, value))
    .catch((error) => console.warn('Failed to save model preferences', error))
}

watch(
  () => ({ ...presetForm.models }),
  (models) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(presetStorageKey, JSON.stringify(models))
    if (!presetPreferencesHydrated) return
    savePresetPreferences()
  },
  { deep: true },
)

async function loadCfgs() { try { cfgs.value = await aiConfigAPI.list() } catch (e) { toast.error(e.message) } }
async function toggleCfg(c) { await aiConfigAPI.update(c.id, { is_active: !c.is_active }); loadCfgs() }
async function delCfg(id) { await aiConfigAPI.del(id); toast.success('已删除'); loadCfgs() }
async function saveAssetUploadKey() {
  if (!assetKeyDraft.value) {
    toast.warning('请填写火山素材上传 Key')
    return
  }
  assetKeySaving.value = true
  try {
    const payload = {
      name: '火山素材上传 Key',
      provider: 'volcengine_asset',
      base_url: 'https://20nbifxd.magine.work',
      model: [],
      priority: 96,
      settings: { asset: { uploadBaseUrl: 'https://api.magine.work/v1', projectName: 'default' } },
      is_active: true,
      api_key: assetKeyDraft.value,
    }
    if (assetUploadConfig.value?.id) {
      await aiConfigAPI.update(assetUploadConfig.value.id, payload)
    } else {
      await aiConfigAPI.create({ ...payload, service_type: 'asset' })
    }
    assetKeyDraft.value = ''
    await loadCfgs()
    toast.success('火山素材上传 Key 已保存')
  } catch (e) {
    toast.error(e.message)
  } finally {
    assetKeySaving.value = false
  }
}
async function testAssetUploadKey() {
  assetKeyTesting.value = true
  try {
    const payload = assetKeyDraft.value
      ? {
          service_type: 'asset',
          provider: 'volcengine_asset',
          api_key: assetKeyDraft.value,
          base_url: 'https://20nbifxd.magine.work',
          model: [],
        }
      : { service_type: 'asset', provider: 'volcengine_asset', id: assetUploadConfig.value?.id }
    assetKeyTestResult.value = await aiConfigAPI.test(payload)
    if (assetKeyTestResult.value.reachable) toast.success('素材上传 Key 测试通过')
    else toast.warning(assetKeyTestResult.value.message || '素材上传 Key 未通过测试')
  } catch (e) {
    toast.error(e.message)
  } finally {
    assetKeyTesting.value = false
  }
}
async function saveEggfansImageHostKey() {
  if (!eggfansImageHostKeyDraft.value) {
    toast.warning('请填写 Eggfans 备用图床 Key')
    return
  }
  eggfansImageHostKeySaving.value = true
  try {
    const payload = {
      name: 'Eggfans 备用图床 Key',
      provider: 'eggfans_image_host',
      base_url: 'https://imageproxy.zhongzhuan.chat/api/upload',
      model: [],
      priority: 95,
      settings: { imageHost: { uploadUrl: 'https://imageproxy.zhongzhuan.chat/api/upload' } },
      is_active: true,
      api_key: eggfansImageHostKeyDraft.value,
    }
    if (eggfansImageHostConfig.value?.id) {
      await aiConfigAPI.update(eggfansImageHostConfig.value.id, payload)
    } else {
      await aiConfigAPI.create({ ...payload, service_type: 'image_host' })
    }
    eggfansImageHostKeyDraft.value = ''
    await loadCfgs()
    toast.success('Eggfans 备用图床 Key 已保存')
  } catch (e) {
    toast.error(e.message)
  } finally {
    eggfansImageHostKeySaving.value = false
  }
}
async function testEggfansImageHostKey() {
  eggfansImageHostKeyTesting.value = true
  try {
    const payload = eggfansImageHostKeyDraft.value
      ? {
          service_type: 'image_host',
          provider: 'eggfans_image_host',
          api_key: eggfansImageHostKeyDraft.value,
          base_url: 'https://imageproxy.zhongzhuan.chat/api/upload',
          model: [],
        }
      : { service_type: 'image_host', provider: 'eggfans_image_host', id: eggfansImageHostConfig.value?.id }
    eggfansImageHostKeyTestResult.value = await aiConfigAPI.test(payload)
    if (eggfansImageHostKeyTestResult.value.reachable) toast.success('Eggfans 图床 Key 测试通过')
    else toast.warning(eggfansImageHostKeyTestResult.value.message || 'Eggfans 图床 Key 未通过测试')
  } catch (e) {
    toast.error(e.message)
  } finally {
    eggfansImageHostKeyTesting.value = false
  }
}
function startAddCfg(t) {
  cfgEditId.value = null
  cfgTestResult.value = null
  Object.assign(cfgForm, {
    name: '',
    provider: '',
    api_key: '',
    base_url: '',
    modelStr: '',
    service_type: t,
    priority: 0,
    endpoint: '',
    query_endpoint: '',
    settings: null,
  })
  const firstPreset = presetsByType(t)[0]
  if (firstPreset) applyProviderPreset(t, firstPreset.provider)
  cfgDialog.value = true
}
function startEditCfg(c) {
  cfgEditId.value = c.id
  cfgTestResult.value = null
  Object.assign(cfgForm, {
    name: c.name || '',
    provider: c.provider,
    api_key: '',
    base_url: c.base_url || '',
    modelStr: fmtModel(c.model),
    service_type: c.service_type,
    priority: c.priority ?? 0,
    endpoint: c.endpoint || '',
    query_endpoint: c.query_endpoint || '',
    settings: c.settings || null,
  })
  if (c.provider === 'eggfans') {
    loadEggfansModels(c.service_type).then(() => {
      if (!cfgForm.settings?.eggfans) applyEggfansModel(cfgForm.modelStr)
    })
  }
  if (c.provider === 'mijing') {
    loadMijingModels(c.service_type).then(() => {
      if (!cfgForm.settings?.mijing) applyMijingModel(cfgForm.modelStr)
    })
  }
  if (c.provider === 'grok_openai' && c.service_type === 'video') {
    applyGrokOpenAIModel(cfgForm.modelStr)
  }
  cfgDialog.value = true
}
async function testCfgPayload(payload) {
  cfgTesting.value = true
  try {
    cfgTestResult.value = await aiConfigAPI.test(payload)
    if (cfgTestResult.value.reachable) toast.success('配置测试通过')
    else toast.warning(cfgTestResult.value.message || '配置未通过测试')
  } catch (e) {
    toast.error(e.message)
  } finally {
    cfgTesting.value = false
  }
}
async function testDraftCfg() {
  await testCfgPayload({
    service_type: cfgForm.service_type,
    provider: cfgForm.provider,
    api_key: cfgForm.api_key,
    base_url: cfgForm.base_url,
    model: cfgForm.modelStr.split(',').map(s => s.trim()).filter(Boolean),
    endpoint: cfgForm.endpoint || null,
    query_endpoint: cfgForm.query_endpoint || null,
    settings: cfgForm.settings || null,
  })
}
async function testExistingCfg(c) {
  startEditCfg(c)
  await testCfgPayload({
    service_type: c.service_type,
    provider: c.provider,
    id: c.id,
  })
}
async function saveCfg() {
  if (!cfgForm.provider) { toast.warning('选择服务商'); return }
  const models = cfgForm.modelStr.split(',').map(s => s.trim()).filter(Boolean)
  try {
    const payload = {
      name: cfgForm.name,
      provider: cfgForm.provider,
      base_url: cfgForm.base_url,
      model: models,
      endpoint: cfgForm.endpoint || null,
      query_endpoint: cfgForm.query_endpoint || null,
      settings: cfgForm.settings || null,
      priority: cfgForm.priority,
    }
    if (cfgForm.api_key) Object.assign(payload, { api_key: cfgForm.api_key })
    if (cfgEditId.value) await aiConfigAPI.update(cfgEditId.value, payload)
    else await aiConfigAPI.create({ ...payload, service_type: cfgForm.service_type, name: cfgForm.name || `${cfgForm.provider}-${cfgForm.service_type}`, api_key: cfgForm.api_key })
    cfgDialog.value = false; toast.success('已保存'); loadCfgs()
  } catch (e) { toast.error(e.message) }
}
async function applyEggfansPreset() {
  if (!presetForm.eggfansApiKey) {
    toast.warning('请填写 Eggfans API Key')
    return
  }
  try {
    await aiConfigAPI.eggfansPreset(presetForm.eggfansApiKey, presetForm.seedanceApiKey || undefined, { ...presetForm.models })
    await loadCfgs()
    await loadAgents()
    presetDialog.value = false
    toast.success(presetForm.seedanceApiKey
      ? 'Eggfans 配置已写入，Seedance 2.0 使用火山官方接口'
      : 'Eggfans 配置已写入，Seedance 2.0 官方通道已内置，后续补火山 Key 即可调用')
  } catch (e) {
    toast.error(e.message)
  }
}

// ===== Agent Configs =====
const agentCfgs = ref([])
const editingAgent = ref(null)
const agentSaving = ref(false)
const agentSaved = ref(null)
const agentForm = reactive({ model: '', temperature: 0.7, max_tokens: 4096, max_iterations: 10, system_prompt: '' })

const agentDefs = [
  { type: 'script_rewriter', label: '剧本改写', icon: '📝' },
  { type: 'extractor', label: '角色场景提取', icon: '🔍' },
  { type: 'storyboard_breaker', label: '分镜拆解', icon: '🎬' },
  { type: 'voice_assigner', label: '音色分配', icon: '🎙' },
  { type: 'grid_prompt_generator', label: '图片提示词生成', icon: '🖼' },
]

const defaultPrompts = {
  script_rewriter: `你是专业编剧，擅长将小说改编为短剧剧本。

工作流程：
1. 调用 read_episode_script 读取原始内容
2. 根据读取到的内容，自己进行改写（输出格式化剧本格式）
3. 调用 save_script 保存改写后的完整剧本

格式化剧本格式：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容`,
  extractor: `你是制片助理，擅长从剧本中提取角色和场景信息，并在提取时与项目已有数据进行智能去重。

工作流程：
1. 调用 read_script_for_extraction 读取格式化剧本
2. 调用 read_existing_characters 读取项目中已存在的角色列表（用于去重）
3. 调用 read_existing_scenes 读取项目中已存在的场景列表（用于去重）
4. 分析剧本内容，提取所有角色信息
5. 对每个角色：若同名已存在则合并更新，若不存在则新增
6. 调用 save_dedup_characters 保存角色（去重合并，自动处理新增和更新）
7. 分析剧本内容，提取所有场景信息
8. 对每个场景：若同地点+时间段已存在则复用，若不存在则新增
9. 调用 save_dedup_scenes 保存场景（去重合并，自动处理新增和复用）

去重规则：
- 角色：按名字精确匹配，同名保留现有（合并信息）
- 场景：按【地点+时间段】精确匹配；同地点不同时段视为新场景

提取要求：
- 角色要包含完整的外貌特征描述（发型、服装、体态等）
- 场景要包含光线、色调、氛围等视觉信息
- 不要遗漏任何有台词或重要动作的角色`,
  storyboard_breaker: `你是资深影视分镜师，擅长将剧本拆解为分镜方案。

工作流程：
1. 调用 read_storyboard_context 读取剧本、角色列表、场景列表
2. 将剧本拆解为镜头序列（默认每个镜头 10-15 秒；如果用户消息包含目标视频模型规则，以目标模型规则为准）
3. 为每个镜头生成视频提示词（video_prompt）
4. 调用 save_storyboards 保存所有分镜`,
  voice_assigner: `你是配音导演，擅长为角色选择合适的音色。

工作流程：
1. 调用 list_voices 获取可用音色列表
2. 调用 get_characters 获取所有角色信息
3. 根据每个角色的性别、性格、年龄、角色定位，选择最匹配的音色
4. 对每个角色调用 assign_voice 分配音色，并说明选择理由

注意：每个角色都必须分配音色，不要遗漏。`,
  grid_prompt_generator: `你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：每格=一个镜头的首帧，NxN 风格统一
   - first_last 模式：每个镜头占2格（左首右尾），同一行风格连续
   - multi_ref 模式：所有格子都是同一镜头的不同参考角度
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）

提示词规范：
- 使用英文提示词
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印`,
}

function getAgentCfg(type) {
  return agentCfgs.value.find(a => a.agent_type === type)
}

function defaultAgentMaxTokens(type) {
  return type === 'storyboard_breaker' ? 12000 : 4096
}

function defaultAgentMaxIterations(type) {
  return type === 'storyboard_breaker' ? 20 : 10
}

function resolvedAgentMaxTokens(type, value) {
  return Math.max(Number(value || 0), defaultAgentMaxTokens(type))
}

function resolvedAgentMaxIterations(type, value) {
  return Math.max(Number(value || 0), defaultAgentMaxIterations(type))
}

const textModelGroups = computed(() => {
  return cfgs.value
    .filter(c => c.service_type === 'text' && c.is_active && c.has_api_key)
    .map(c => ({
      label: `${c.provider} — ${c.name}`,
      models: Array.isArray(c.model) ? c.model : (c.model ? [c.model] : []),
    }))
    .filter(g => g.models.length > 0)
})

const textModelSelectOptions = computed(() =>
  textModelGroups.value.map(g => ({
    label: g.label,
    options: g.models.map(m => ({ label: m, value: m })),
  }))
)

async function loadAgents() {
  try { agentCfgs.value = await agentConfigAPI.list() }
  catch (e) { toast.error(e.message) }
}

function toggleAgentEdit(type) {
  if (editingAgent.value === type) { editingAgent.value = null; return }
  const cfg = getAgentCfg(type)
  agentForm.model = cfg?.model || ''
  agentForm.temperature = cfg?.temperature ?? 0.7
  agentForm.max_tokens = resolvedAgentMaxTokens(type, cfg?.max_tokens)
  agentForm.max_iterations = resolvedAgentMaxIterations(type, cfg?.max_iterations)
  agentForm.system_prompt = cfg?.system_prompt || defaultPrompts[type] || ''
  agentSaved.value = null
  editingAgent.value = type
}

function resetAgentPrompt(type) {
  agentForm.system_prompt = defaultPrompts[type] || ''
  toast.info('已恢复默认提示词，点击保存生效')
}

async function saveAgentCfg(type) {
  agentSaving.value = true
  agentSaved.value = null
  try {
    const existing = getAgentCfg(type)
    const data = {
      agent_type: type,
      name: agentDefs.find(a => a.type === type)?.label || type,
      model: agentForm.model,
      temperature: agentForm.temperature,
      max_tokens: agentForm.max_tokens,
      max_iterations: agentForm.max_iterations,
      system_prompt: agentForm.system_prompt,
    }
    if (existing) {
      await agentConfigAPI.update(existing.id, data)
    } else {
      await agentConfigAPI.create(data)
    }
    await loadAgents()
    agentSaved.value = type
    toast.success(`${agentDefs.find(a => a.type === type)?.label} 配置已保存`)
    setTimeout(() => { if (agentSaved.value === type) agentSaved.value = null }, 3000)
  } catch (e) {
    toast.error(e.message)
  } finally {
    agentSaving.value = false
  }
}

// ===== Skills =====
const selectedAgent = ref('script_rewriter')
const allSkills = ref([])   // { id, name, description }[]
const editingSkill = ref(null)
const skillContent = ref('')
const skillSaving = ref(false)
const skillSaved = ref(null)
const addSkillDialog = ref(false)
const newSkillForm = reactive({ id: '', name: '', description: '' })

const selectedAgentType = computed(() => selectedAgent.value)
const selectedAgentLabel = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.label || '')
const selectedAgentIcon = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.icon || '')

function agentSkillCount(type) {
  return allSkills.value.filter(s => s.id === type || s.id.startsWith(type + '/')).length
}

const currentSkills = computed(() =>
  allSkills.value.filter(s => s.id === selectedAgent.value || s.id.startsWith(selectedAgent.value + '/'))
)

async function loadAllSkills() {
  try { allSkills.value = await skillsAPI.list() }
  catch (e) { toast.error(e.message) }
}

async function selectAgent(type) {
  selectedAgent.value = type
  editingSkill.value = null
}

function startAddSkill() {
  newSkillForm.id = ''
  newSkillForm.name = ''
  newSkillForm.description = ''
  addSkillDialog.value = true
}

async function confirmAddSkill() {
  if (!newSkillForm.id) return
  const skillId = `${selectedAgent.value}/${newSkillForm.id}`
  try {
    await skillsAPI.create({ id: skillId, name: newSkillForm.name, description: newSkillForm.description })
    addSkillDialog.value = false
    await loadAllSkills()
    toast.success('Skill 创建成功')
  } catch (e) {
    toast.error(e.message)
  }
}

async function deleteSkill(id) {
  if (!confirm(`确定删除 Skill「${id}」？`)) return
  try {
    await skillsAPI.del(id)
    if (editingSkill.value === id) editingSkill.value = null
    await loadAllSkills()
    toast.success('已删除')
  } catch (e) {
    toast.error(e.message)
  }
}

async function toggleSkillEdit(id) {
  if (editingSkill.value === id) { editingSkill.value = null; return }
  try {
    const res = await skillsAPI.get(id)
    skillContent.value = res.content
    skillSaved.value = null
    editingSkill.value = id
  } catch (e) { toast.error(e.message) }
}

async function saveSkill(id) {
  skillSaving.value = true
  skillSaved.value = null
  try {
    await skillsAPI.update(id, skillContent.value)
    await loadAllSkills()
    skillSaved.value = id
    toast.success(`已保存`)
    setTimeout(() => { if (skillSaved.value === id) skillSaved.value = null }, 3000)
  } catch (e) {
    toast.error(e.message)
  } finally {
    skillSaving.value = false
  }
}

onMounted(() => { loadPresetPreferences(); loadCfgs(); loadAgents(); loadAllSkills() })
</script>

<style scoped>
.settings-layout { display: flex; height: 100%; background: var(--bg-base); }

.settings-nav {
  width: 220px; flex-shrink: 0; padding: 16px 10px; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 14px; background: var(--bg-1);
}
.nav-group { display: flex; flex-direction: column; gap: 4px; }
.nav-group-label {
  font-size: 10px; font-weight: 700; color: var(--text-3);
  letter-spacing: 0.12em; text-transform: uppercase; padding: 0 10px 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 13px;
  border: none; background: none; color: var(--text-2); cursor: pointer;
  border-radius: var(--radius); transition: all 0.12s; text-align: left; width: 100%;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-0); }
.nav-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 600; box-shadow: var(--shadow-card); }
.nav-advanced {
  padding: 12px 8px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}
.advanced-toggle {
  display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px;
  font-size: 12px; color: var(--text-2);
}
.advanced-toggle input { display: none; }
.advanced-slider {
  position: relative; width: 38px; height: 22px; border-radius: 999px;
  background: rgba(27, 41, 64, 0.12); transition: background 0.18s ease;
}
.advanced-slider::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(18, 24, 38, 0.18); transition: transform 0.18s ease;
}
.advanced-toggle input:checked + .advanced-slider { background: var(--accent); }
.advanced-toggle input:checked + .advanced-slider::after { transform: translateX(16px); }
.advanced-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-3);
}

.settings-content { flex: 1; overflow: hidden; }
.settings-scroll { height: 100%; overflow-y: auto; padding: 36px 48px; max-width: 840px; margin: 0 auto; animation: fadeUp 0.3s var(--ease-out); }
.settings-head { margin-bottom: 24px; }
.settings-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.settings-brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 15px;
  border: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,247,255,0.9));
  box-shadow: var(--shadow-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-brand-logo {
  width: 26px;
  height: 26px;
  object-fit: contain;
  display: block;
}
.settings-brand-fallback {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--accent-text);
  line-height: 1;
}
.settings-brand-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  line-height: 1;
}
.settings-brand-kicker {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.settings-brand-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.settings-title { font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.settings-desc { font-size: 13px; color: var(--text-2); margin-top: 4px; }

/* AI Config */
.setup-panel {
  padding: 18px 18px 16px;
  margin-bottom: 18px;
}
.setup-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.setup-panel-head > .btn + .btn {
  margin-left: -8px;
}

.setup-panel-head.compact { margin-bottom: 12px; }
.setup-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 4px;
}
.setup-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-0);
}
.setup-desc {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.preset-grid.compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 8px;
}
.preset-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255,255,255,0.82);
  padding: 12px 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preset-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.preset-service { font-size: 12px; font-weight: 600; }
.preset-model { font-size: 12px; color: var(--text-1); }
.preset-base { font-size: 11px; color: var(--text-3); }
.template-row { display: flex; flex-wrap: wrap; gap: 8px; }
.template-type-chip {
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.82);
  color: var(--text-1);
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: 0.15s;
}
.template-type-chip:hover {
  border-color: var(--accent);
  color: var(--accent-text);
  background: var(--accent-bg);
}
.asset-key-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: end;
}
.asset-key-field {
  min-width: 0;
}
.sections { display: flex; flex-direction: column; gap: 24px; }
.section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.section-title { font-size: 13px; font-weight: 600; }
.section-subtitle { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.config-list { display: flex; flex-direction: column; gap: 6px; }
.config-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
.config-info { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.config-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.config-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.config-provider { font-size: 13px; font-weight: 600; }
.config-name { font-size: 12px; color: var(--text-2); }
.config-model { font-size: 11px; color: var(--text-2); }
.config-base { font-size: 11px; color: var(--text-3); }
.config-empty { font-size: 12px; color: var(--text-3); padding: 12px 0; }

.toggle { position: relative; width: 30px; height: 17px; cursor: pointer; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle span { position: absolute; inset: 0; background: var(--bg-3); border-radius: 99px; transition: 0.2s; }
.toggle span::before { content: ''; position: absolute; width: 13px; height: 13px; left: 2px; bottom: 2px; background: var(--bg-0); border-radius: 50%; transition: 0.2s; box-shadow: var(--shadow); }
.toggle input:checked + span { background: var(--accent); }
.toggle input:checked + span::before { transform: translateX(13px); }

/* Agent */
.agent-list { display: flex; flex-direction: column; gap: 8px; }
.agent-card { overflow: hidden; }
.agent-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; transition: background 0.1s; }
.agent-card-head:hover { background: var(--bg-hover); }
.agent-type-badge { width: 36px; height: 36px; border-radius: var(--radius); background: var(--accent-bg); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.agent-card-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 16px; }
.agent-card-foot { display: flex; align-items: center; gap: 8px; padding-top: 8px; }

/* Skills 布局 */
.skills-layout { display: flex; height: 100%; overflow: hidden; }
.skills-agent-list {
  width: 200px; flex-shrink: 0; border-right: 1px solid var(--border);
  background: var(--bg-1); display: flex; flex-direction: column;
  overflow-y: auto;
}
.skills-agent-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-3); padding: 14px 14px 8px;
}
.skills-agent-item {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; font-size: 13px; cursor: pointer;
  border: none; background: none; color: var(--text-2);
  transition: all 0.12s; width: 100%; text-align: left;
  border-radius: 0;
}
.skills-agent-item:hover { background: var(--bg-hover); color: var(--text-0); }
.skills-agent-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 600; }
.skills-agent-label { flex: 1; }
.skill-count-badge {
  font-size: 10px; font-weight: 700; font-family: var(--font-mono);
  background: var(--accent-bg); color: var(--accent-text);
  padding: 1px 5px; border-radius: 99px;
}
.skills-agent-item.active .skill-count-badge { background: rgba(255,255,255,0.2); color: inherit; }
.skills-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.skills-main .settings-scroll { max-width: 900px; }

/* Skill */
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-card { overflow: hidden; }
.skill-card-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; transition: background 0.1s; }
.skill-card-head:hover { background: var(--bg-hover); }
.skill-card-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 12px; }
.skill-card-foot { display: flex; align-items: center; gap: 8px; }

/* Shared */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-hint { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.overlay { position: fixed; inset: 0; background: rgba(34,45,66,0.32); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fadeIn 0.18s var(--ease-out); }
.modal { padding: 28px; width: 420px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-elevated); }
.modal-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; }
.config-modal { width: min(720px, calc(100vw - 40px)); max-height: calc(100vh - 48px); overflow-y: auto; }
.config-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.modal-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.preset-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.preset-pill {
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.72);
  color: var(--text-1);
  border-radius: 999px;
  padding: 8px 11px;
  font-size: 12px;
  cursor: pointer;
}
.preset-pill:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.endpoint-hint {
  margin-top: -4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: rgba(244,248,255,0.72);
  font-size: 12px;
}
.eggfans-model-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(66, 122, 217, 0.18);
  background: rgba(244,248,255,0.72);
  font-size: 12px;
}
.eggfans-model-meta > div {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.eggfans-model-meta .dim {
  flex: 0 0 58px;
}
.eggfans-model-meta .mono {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: normal;
  line-height: 1.45;
}
.provider-note {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(217, 156, 66, 0.24);
  background: rgba(255, 248, 232, 0.82);
  color: var(--text-2);
  font-size: 12px;
}
.test-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.72);
}
.test-result.ok { border-color: rgba(74, 167, 92, 0.28); }
.test-result.bad { border-color: rgba(201, 88, 68, 0.28); }
.test-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}
.test-result-url,
.test-result-preview {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
.preset-form-grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 10px;
}
.preset-form-grid .field-hint a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.preset-form-grid .field-hint a:hover {
  text-decoration: underline;
}
.preset-editor {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 8px;
  background: rgba(244,248,255,0.58);
}
.preset-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.preset-model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 900px) {
  .preset-grid,
  .preset-grid.compact,
  .preset-model-grid {
    grid-template-columns: 1fr;
  }
  .setup-panel-head {
    flex-wrap: wrap;
  }
  .asset-key-row {
    grid-template-columns: 1fr;
  }
}
</style>
