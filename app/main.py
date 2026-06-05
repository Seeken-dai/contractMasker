import os
import uuid
import json
import shutil
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.database import DatabaseManager
from app.masker import DocxMasker

SYSTEM_VERSION = "1.2.0"

# 初始化 FastAPI，配置中文元数据说明
app = FastAPI(
    title="合同智能脱敏服务 API 接口文档",
    description="本接口文档提供了供外部系统（如 OA、审批流、档案管理等系统）对接合同脱敏与还原功能的标准 RESTful API。",
    version=SYSTEM_VERSION
)

# 跨域设置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 确保目录存在
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMP_DIR = os.path.join(BASE_DIR, "temp_files")
TEMP_OUT_DIR = os.path.join(TEMP_DIR, "temp_out")
os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(TEMP_OUT_DIR, exist_ok=True)

db = DatabaseManager()

# 定义请求实体模型并绑定中文 API 描述
class RuleCreate(BaseModel):
    name: str = Field(..., description="规则名称，如：身份证号")
    pattern: Optional[str] = Field(None, description="正则表达式，留空则代表纯手动划词标注")
    is_enabled: int = Field(1, description="是否启用该规则（1为启用，0为禁用）")
    description: str = Field("", description="规则的用途描述")

class RuleUpdate(BaseModel):
    name: str = Field(..., description="规则名称")
    pattern: Optional[str] = Field(None, description="正则表达式")
    is_enabled: int = Field(..., description="是否启用该规则")
    description: str = Field("", description="规则的用途描述")

class MaskMatch(BaseModel):
    block_idx: int = Field(..., description="段落物理序号，从0递增")
    start: int = Field(..., description="敏感词在段落内的绝对起始字符偏移索引")
    end: int = Field(..., description="敏感词在段落内的绝对截止字符偏移索引")
    category: str = Field(..., description="敏感词的类别名称")
    original_text: str = Field(..., description="被替换的原始敏感词文本")
    placeholder: str = Field(..., description="用于替换该敏感词的占位符代号")

class MaskRequest(BaseModel):
    file_token: str = Field(..., description="临时上传的文件标识符（Token）")
    matches: List[MaskMatch] = Field(..., description="前端确认的脱敏敏感词标注列表")


# --- 页面路由 ---
@app.get("/", include_in_schema=False)
async def get_index():
    """返回前端静态交互页面"""
    index_path = os.path.join(BASE_DIR, "static", "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "欢迎使用脱敏服务。前端静态资源丢失。"}


# --- 规则管理 API ---
@app.get("/api/rules", tags=["规则管理"], summary="获取所有脱敏规则")
async def get_rules():
    """
    拉取本地 SQLite 数据库中配置的所有规则，包含内置规则与自定义规则。
    """
    return db.get_all_rules()

@app.post("/api/rules", tags=["规则管理"], summary="创建自定义脱敏规则")
async def add_rule(rule: RuleCreate):
    """
    允许用户创建自定义的正则表达式规则来匹配特定的敏感资产（如特定的合同号、工号等）。
    """
    try:
        rule_id = db.add_rule(rule.name, rule.pattern, rule.is_enabled, rule.description)
        return {"id": rule_id, "message": "自定义规则创建成功"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"创建规则失败: {str(e)}")

@app.put("/api/rules/{rule_id}", tags=["规则管理"], summary="更新指定脱敏规则")
async def update_rule(rule_id: int, rule: RuleUpdate):
    """
    更新某项规则的匹配正则、启用状态或业务说明。
    """
    try:
        db.update_rule(rule_id, rule.name, rule.pattern, rule.is_enabled, rule.description)
        return {"message": "规则更新成功"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"更新规则失败: {str(e)}")

@app.delete("/api/rules/{rule_id}", tags=["规则管理"], summary="删除自定义脱敏规则")
async def delete_rule(rule_id: int):
    """
    彻底删除一条自定义的脱敏规则。内置标准规则不允许被删除。
    """
    try:
        rule = db.get_rule_by_id(rule_id)
        if not rule:
            raise HTTPException(status_code=404, detail="该规则不存在")
            
        # 拦截所有内置标准规则
        builtin_names = {
            "手机号", "固定电话", "电子邮箱", "统一社会信用代码/税号", 
            "银行卡号", "身份证号", "时间信息", "企业名称", "大写金额", "数值金额", "百分比", "人名"
        }
        if rule["name"] in builtin_names:
            raise HTTPException(status_code=400, detail=f"标准内置规则【{rule['name']}】禁止删除")
            
        db.delete_rule(rule_id)
        return {"message": "规则删除成功"}
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"删除规则失败: {str(e)}")


@app.get("/api/config", tags=["配置管理"], summary="获取系统运行配置")
async def get_config():
    """
    获取全局配置文件中自定义的产品名称等系统属性以及系统版本号。
    """
    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
    app_name = "合同智能脱敏"
    if os.path.exists(config_path):
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "app_name" in data:
                    app_name = data["app_name"]
        except Exception:
            pass
    return {"app_name": app_name, "version": SYSTEM_VERSION}


@app.get("/mask", tags=["独立功能页面"], summary="访问独立文档脱敏页面")
async def get_mask_page():
    """
    为普通用户提供安全的独立文档脱敏页面，不包含配置管理等敏感模块。
    """
    return FileResponse("static/mask.html")


@app.get("/restore", tags=["独立功能页面"], summary="访问独立文档还原页面")
async def get_restore_page():
    """
    为普通用户提供安全的独立文档还原页面，不包含配置管理等敏感模块。
    """
    return FileResponse("static/restore.html")


# --- 网页端脱敏交互流程 API ---

@app.post("/api/upload", tags=["网页端脱敏流程"], summary="上传原始合同并初筛敏感词")
async def upload_document(file: UploadFile = File(..., description="要解析的原始 Word 合同文件 (.docx)")):
    """
    上传合同样本。后端提取各段落及表格内的纯文本，并根据启用的规则库执行正则匹配与分词，返回给前端以供划词确认。
    """
    if not file.filename.endswith(".docx"):
        raise HTTPException(status_code=400, detail="仅支持 .docx 格式的 Word 文档")
        
    file_token = str(uuid.uuid4())
    temp_path = os.path.join(TEMP_DIR, f"{file_token}.docx")
    
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    try:
        masker = DocxMasker(temp_path)
        structure = masker.extract_text_structure()
        
        enabled_rules = db.get_enabled_rules()
        matches = masker.match_sensitive_data(enabled_rules)
        
        return {
            "file_token": file_token,
            "filename": file.filename,
            "structure": structure,
            "suggested_matches": matches
        }
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=f"解析文档结构失败: {str(e)}")


@app.post("/api/mask", tags=["网页端脱敏流程"], summary="确认标注并执行合同脱敏")
async def mask_document(req: MaskRequest):
    """
    根据用户在前端审核、纠错或手动划词后提交的标注清单，执行高保真 Word 节点重写，隐写 UUID，并保存到本地数据库以备还原。
    """
    temp_path = os.path.join(TEMP_DIR, f"{req.file_token}.docx")
    if not os.path.exists(temp_path):
        raise HTTPException(status_code=400, detail="原始上传文件已失效，请重新上传")
        
    try:
        masker = DocxMasker(temp_path)
        
        matches_by_block = {}
        db_mappings = []
        
        for m in req.matches:
            b_idx = m.block_idx
            if b_idx not in matches_by_block:
                matches_by_block[b_idx] = []
            
            matches_by_block[b_idx].append({
                "start": m.start,
                "end": m.end,
                "placeholder": m.placeholder
            })
            
            db_mappings.append({
                "placeholder": m.placeholder,
                "original_text": m.original_text,
                "category": m.category
            })
            
        doc_uuid = str(uuid.uuid4())
        masked_file_path = masker.mask_document(matches_by_block, doc_uuid)
        
        original_filename = os.path.basename(temp_path)
        masked_filename = f"masked_{doc_uuid[:8]}.docx"
        
        db.save_document_mappings(doc_uuid, original_filename, masked_filename, db_mappings)
        
        if os.path.exists(temp_path):
            os.remove(temp_path)
            
        return {
            "uuid": doc_uuid,
            "download_url": f"/api/download/{doc_uuid}",
            "filename": masked_filename,
            "mappings": db_mappings
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"脱敏重构失败: {str(e)}")


@app.get("/api/download/{doc_uuid}", tags=["网页端脱敏流程"], summary="下载脱敏后的合同文件")
async def download_masked_file(doc_uuid: str):
    """
    根据文档唯一标识 UUID 下载脱敏后的高保真合同 Word 文件。
    """
    file_path = os.path.join(TEMP_OUT_DIR, f"{doc_uuid}.docx")
    doc_info = db.get_document_info(doc_uuid)
    
    if os.path.exists(file_path) and doc_info:
        return FileResponse(
            file_path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=doc_info["masked_filename"]
        )
    raise HTTPException(status_code=404, detail="文件不存在或已过期")


# --- 网页端还原流程 API ---

@app.post("/api/restore", tags=["网页端还原流程"], summary="网页端一键还原合同")
async def restore_document(
    file: UploadFile = File(..., description="要还原的脱敏合同 (.docx)"),
    key_file: Optional[UploadFile] = File(None, description="备份密钥包 JSON 文件（若不传则自动配对本地数据库，本地无记录时需要手动上传）")
):
    """
    提供给网页端界面的还原服务。支持本地数据库静默配对还原或外置上传 JSON 密钥包备份在线还原。
    """
    if not file.filename.endswith(".docx"):
        raise HTTPException(status_code=400, detail="上传的文件必须是 .docx 格式")
        
    temp_masked_path = os.path.join(TEMP_DIR, f"masked_restore_{uuid.uuid4().hex}.docx")
    
    with open(temp_masked_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    try:
        mappings = []
        
        if key_file is not None:
            try:
                key_content = await key_file.read()
                mappings = json.loads(key_content)
                if not isinstance(mappings, list):
                    raise ValueError("密钥包数据必须是 JSON 列表结构")
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"解析密钥包失败: {str(e)}")
        else:
            try:
                masker = DocxMasker(temp_masked_path)
                doc_uuid = masker.doc.core_properties.identifier
                if not doc_uuid:
                    return JSONResponse(
                        status_code=404,
                        content={"found": False, "detail": "该文档内部未检测到任何隐藏的脱敏标识 UUID"}
                    )
                    
                mappings = db.get_mappings_by_uuid(doc_uuid)
                if not mappings:
                    return JSONResponse(
                        status_code=404,
                        content={"found": False, "detail": f"本地数据库中没有标识为 {doc_uuid} 的映射历史，请上传对应的 JSON 密钥包还原"}
                    )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"解析文档 UUID 失败: {str(e)}")
                
        restored_file_path = DocxMasker.restore_document(temp_masked_path, mappings)
        original_name = "restored_" + file.filename.replace("masked_", "")
        
        return FileResponse(
            restored_file_path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=original_name
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"还原合同失败: {str(e)}")
    finally:
        if os.path.exists(temp_masked_path):
            os.remove(temp_masked_path)


# --- 外部系统 OpenAPI 接口段 ---

@app.post("/api/openapi/mask", tags=["外部系统 OpenAPI 接口"], summary="开放接口：自动化合同文档脱敏")
async def openapi_mask_document(
    file: UploadFile = File(..., description="要脱敏的原始 Word 合同文档 (.docx)"),
    categories: Optional[str] = Form(None, description="需要脱敏的类别列表，用逗号分隔（如: '手机号,企业名称'），留空则使用所有已启用的规则分类")
):
    """
    **自动化无状态对接接口**：供外部系统直接调用。
    
    上传合同样本，后端全自动提取文本执行匹配，替换为高保真占位符，安全保存映射关系，直接返回包含 UUID 和 mappings 列表的 JSON 结果。
    """
    if not file.filename.endswith(".docx"):
        raise HTTPException(status_code=400, detail="仅支持 .docx 格式的 Word 文档")

    file_token = str(uuid.uuid4())
    temp_path = os.path.join(TEMP_DIR, f"{file_token}_openapi.docx")
    
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    try:
        masker = DocxMasker(temp_path)
        
        all_enabled_rules = db.get_enabled_rules()
        if categories:
            allowed_cats = [c.strip() for c in categories.split(",") if c.strip()]
            rules_to_run = [r for r in all_enabled_rules if r["name"] in allowed_cats]
        else:
            rules_to_run = all_enabled_rules
            
        matches = masker.match_sensitive_data(rules_to_run)
        
        # 自动化分配占位符
        category_counters = {}
        text_to_placeholder = {}
        
        matches = sorted(matches, key=lambda x: (x["block_idx"], x["start"]))
        for m in matches:
            key = f"{m['category']}_{m['original_text']}"
            if key not in text_to_placeholder:
                count = category_counters.get(m['category'], 0) + 1
                category_counters[m['category']] = count
                text_to_placeholder[key] = f"[{m['category']}_{count}]"
            m['placeholder'] = text_to_placeholder[key]
            
        matches_by_block = {}
        db_mappings = []
        for m in matches:
            b_idx = m['block_idx']
            if b_idx not in matches_by_block:
                matches_by_block[b_idx] = []
            matches_by_block[b_idx].append({
                'start': m['start'],
                'end': m['end'],
                'placeholder': m['placeholder']
            })
            db_mappings.append({
                'placeholder': m['placeholder'],
                'original_text': m['original_text'],
                'category': m['category']
            })
            
        doc_uuid = str(uuid.uuid4())
        masked_file_path = masker.mask_document(matches_by_block, doc_uuid)
        
        masked_filename = f"masked_{doc_uuid[:8]}.docx"
        db.save_document_mappings(doc_uuid, file.filename, masked_filename, db_mappings)
        
        if os.path.exists(temp_path):
            os.remove(temp_path)
            
        return {
            "success": True,
            "uuid": doc_uuid,
            "download_url": f"/api/download/{doc_uuid}",
            "filename": masked_filename,
            "mappings": db_mappings
        }
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=f"自动化脱敏处理失败: {str(e)}")


@app.post("/api/openapi/restore", tags=["外部系统 OpenAPI 接口"], summary="开放接口：自动化合同文档还原")
async def openapi_restore_document(
    file: UploadFile = File(..., description="要还原的已脱敏合同文档 (.docx)"),
    key_file: Optional[UploadFile] = File(None, description="备份密钥包 JSON 文件（可选，若不传则自动匹配本地 SQLite 数据库还原）")
):
    """
    **自动化文档一键还原接口**：供外部系统直接调用。
    
    上传脱敏后的文档（及可选的 JSON 密钥包），系统在线执行还原并**以二进制文件流格式直接返回还原后的 Word 原始文档**。
    """
    if not file.filename.endswith(".docx"):
        raise HTTPException(status_code=400, detail="上传的文件必须是 .docx 格式")
        
    temp_masked_path = os.path.join(TEMP_DIR, f"openapi_restore_{uuid.uuid4().hex}.docx")
    
    with open(temp_masked_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    try:
        mappings = []
        
        if key_file is not None:
            try:
                key_content = await key_file.read()
                mappings = json.loads(key_content)
                if not isinstance(mappings, list):
                    raise ValueError("密钥包数据不合法")
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"解析密钥包失败: {str(e)}")
        else:
            masker = DocxMasker(temp_masked_path)
            doc_uuid = masker.doc.core_properties.identifier
            if not doc_uuid:
                raise HTTPException(status_code=404, detail="文档内未检测到隐藏的 UUID 标识")
                
            mappings = db.get_mappings_by_uuid(doc_uuid)
            if not mappings:
                raise HTTPException(status_code=404, detail="本地未检索到配对映射关系，请上传 JSON 密钥包还原")
                
        restored_file_path = DocxMasker.restore_document(temp_masked_path, mappings)
        original_name = "restored_" + file.filename.replace("masked_", "")
        
        return FileResponse(
            restored_file_path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=original_name
        )
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"自动化还原合同失败: {str(e)}")
    finally:
        if os.path.exists(temp_masked_path):
            os.remove(temp_masked_path)


# 挂载静态文件目录 (必须放在所有路由后面，避免冲突)
app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True), name="static")
