import os
import sqlite3
from datetime import datetime
from typing import List, Dict, Any, Optional

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "masking.db")

class DatabaseManager:
    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = db_path
        self.init_db()

    def get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self):
        """初始化表结构，插入默认的脱敏规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            
            # 创建规则表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    pattern TEXT,
                    is_enabled INTEGER DEFAULT 1,
                    description TEXT
                )
            """)

            # 创建文件表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    uuid TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    masked_filename TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # 创建映射关系表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS mappings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_uuid TEXT NOT NULL,
                    placeholder TEXT NOT NULL,
                    original_text TEXT NOT NULL,
                    category TEXT NOT NULL,
                    FOREIGN KEY (document_uuid) REFERENCES documents (uuid) ON DELETE CASCADE
                )
            """)

            # 插入默认的规则
            default_rules = [
                ("手机号", r"1[3-9]\d{9}", 1, "匹配11位大陆手机号码"),
                ("固定电话", r"\d{3,4}-\d{7,8}", 1, "匹配带区号的固定电话号码，如 0755-86013388"),
                ("电子邮箱", r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", 1, "匹配常见的电子邮件地址"),
                ("统一社会信用代码/税号", r"[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}", 1, "匹配18位统一社会信用代码或税务登记号"),
                ("银行卡号", r"[3-6]\d{14,18}", 1, "匹配15-19位银行卡卡号"),
                ("身份证号", r"[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]", 1, "匹配18位二代身份证号码"),
                ("时间信息", r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?", 1, "匹配年月日等日期格式"),
                ("企业名称", r"[\u4e00-\u9fa5]{4,}(?:有限公司|有限责任公司|集团|厂|商行|工作室)", 1, "匹配结尾为有限公司、集团等的中文机构名称"),
                ("人名", None, 1, "基于 Jieba 分词与词性标注(nr)初筛中文姓名，无固定正则")
            ]

            for name, pattern, is_enabled, description in default_rules:
                cursor.execute("""
                    INSERT OR IGNORE INTO rules (name, pattern, is_enabled, description)
                    VALUES (?, ?, ?, ?)
                """, (name, pattern, is_enabled, description))
            
            conn.commit()

    # --- 规则管理接口 ---
    def get_all_rules(self) -> List[Dict[str, Any]]:
        """获取所有规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, pattern, is_enabled, description FROM rules")
            return [dict(row) for row in cursor.fetchall()]

    def get_enabled_rules(self) -> List[Dict[str, Any]]:
        """获取所有启用的规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, pattern, is_enabled, description FROM rules WHERE is_enabled = 1")
            return [dict(row) for row in cursor.fetchall()]

    def add_rule(self, name: str, pattern: Optional[str], is_enabled: int = 1, description: str = "") -> int:
        """添加自定义规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO rules (name, pattern, is_enabled, description)
                VALUES (?, ?, ?, ?)
            """, (name, pattern, is_enabled, description))
            conn.commit()
            return cursor.lastrowid

    def update_rule(self, rule_id: int, name: str, pattern: Optional[str], is_enabled: int, description: str):
        """更新规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE rules
                SET name = ?, pattern = ?, is_enabled = ?, description = ?
                WHERE id = ?
            """, (name, pattern, is_enabled, description, rule_id))
            conn.commit()

    def delete_rule(self, rule_id: int):
        """删除规则"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
            conn.commit()

    # --- 文档与映射管理接口 ---
    def save_document_mappings(self, uuid_str: str, filename: str, masked_filename: str, mappings: List[Dict[str, Any]]):
        """保存文档及其敏感词映射记录"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # 保存文档记录
            cursor.execute("""
                INSERT INTO documents (uuid, filename, masked_filename, created_at)
                VALUES (?, ?, ?, ?)
            """, (uuid_str, filename, masked_filename, datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            
            # 保存映射表记录
            for item in mappings:
                cursor.execute("""
                    INSERT INTO mappings (document_uuid, placeholder, original_text, category)
                    VALUES (?, ?, ?, ?)
                """, (uuid_str, item["placeholder"], item["original_text"], item["category"]))
            
            conn.commit()

    def get_mappings_by_uuid(self, uuid_str: str) -> List[Dict[str, Any]]:
        """根据文档的 UUID 获取映射表数据"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT placeholder, original_text, category 
                FROM mappings 
                WHERE document_uuid = ?
            """, (uuid_str,))
            return [dict(row) for row in cursor.fetchall()]

    def get_document_info(self, uuid_str: str) -> Optional[Dict[str, Any]]:
        """获取脱敏文档的基础信息"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT uuid, filename, masked_filename, created_at 
                FROM documents 
                WHERE uuid = ?
            """, (uuid_str,))
            row = cursor.fetchone()
            return dict(row) if row else None
